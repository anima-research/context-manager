import type { JsStore } from '@animalabs/chronicle';
import type { Membrane, NormalizedRequest, NormalizedResponse, ContentBlock, CompleteOptions } from '@animalabs/membrane';
import { NativeFormatter } from '@animalabs/membrane';
import { registerStateIfAbsent } from '../state-registration.js';
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
  CompressionQuarantineSpan,
  LoadRepairReport,
  LoadRepairDroppedSummary,
  LoadRepairDropReason,
  SummaryLevel,
  SummaryEntry,
  ProtectedRange,
  PinLevelOptions,
  SearchQuery,
  SearchResult,
  TimeRangeSummaryEntry,
  RenderStats,
  CalibrationReset,
  HotContextSettingsUpdate,
  HotContextSettingsStatus,
  SelectOptions,
  PreviewResult,
  RenderedSummaryInfo,
  ThinkingBinding,
} from '../types/index.js';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../types/index.js';
import { getSummaryParentId } from '../types/strategy.js';
import { resolveEffectiveConfig, type ConfigLayer, type EffectiveConfigReport } from '../config-provenance.js';
import { selectKeeperL1s } from './keeper-selection.js';
import { splitMixedToolMessages, stripUnpairedToolBlocks } from '../normalize-tool-messages.js';
import {
  hoistToolProse,
  DEFAULT_TOOL_PROSE_FIELD,
  DEFAULT_TOOL_PROSE_MIN_CHARS,
  DEFAULT_TOOL_PROSE_RESULT,
  type ToolProseHoistOptions,
} from '../tool-prose-hoist.js';
import { recallEnvelopeAddedText, wrapRecallAnswerContent } from '../recall-envelope.js';
import { defaultTokenEstimator, MessageStore } from '../message-store.js';
import { persistMintRequestPreimage } from '../mint-preimage.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Picker, OverBudgetError, UncoveredDropError, type OverBudgetClearedBy, type OverBudgetDiagnostics, type OverBudgetRawPin, type PickerChunk, type PickerInputs, type PickerResult } from '../adaptive/picker.js';
import { FlatProfileStrategy } from '../adaptive/strategies/flat-profile.js';
import { KvStableStrategy } from '../adaptive/strategies/kv-stable.js';
import { reportOverlap } from '../adaptive/kv-control.js';
import { KvUnifiedStrategy, ceilingMark, type KvUnifiedReuse } from '../adaptive/strategies/kv-unified.js';
import { heldLevelPin, type CanonicalSummaryForest } from '../adaptive/kv-unified.js';
import { SummaryTree } from '../adaptive/summary-tree.js';
import { renderLayout, type RenderLayout } from '../adaptive/render-offsets.js';
import { describeFoldDiff, formatFoldDiff, type FoldDiff, type RequestDivergence } from '../adaptive/fold-diff.js';
import {
  KvUnifiedReceiptChain,
  type SerializedReceiptChain,
} from '../adaptive/kv-unified-receipts.js';
import type { CacheRenderRecord, PresentedLeaf, ProviderCacheReference } from '../adaptive/kv-unified-policy.js';
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
import { bodyBoundsIn, bodyEnd, bodyStart } from '../body-runs.js';
import { canonicalJson } from '../canonical-json.js';
import { withoutThinking } from '../thinking-binding.js';
import { releaseEditedRawForms, releaseSharedRawFormsOnMove, releaseTrailingReasoning, releaseVanishedRawForms, withoutRawForms } from '../raw-forms.js';
import { isCompressionWithdrawn } from '../compression-withdrawn.js';
import { hasImage, imagePayload, imagesIn, inlineImageBytes, isImageBlock, replaceImages, strippedImageSaving } from '../inline-images.js';
import { CAP_OMISSION_TEXT, capContent, cappedPriceExtra, cappedWhole, isCapMarker, isEmptyTextBlock } from './message-cap.js';
import type { MessageId } from '../types/message.js';
import type { CarrierPolicy, IngressChunkResult } from '../types/strategy.js';
import { type Diagnostics, namespaceDiagnostics } from '../diagnostics.js';
import { storedJson } from '../stored-json.js';

/** A persisted reset record is trusted only if it has the expected shape. */
function isCalibrationReset(v: unknown): v is CalibrationReset {
  const r = v as CalibrationReset | null | undefined;
  return !!r && Number.isFinite(r.discardedMultiplier) && (r.fromEpoch === null || Number.isFinite(r.fromEpoch)) &&
    Number.isFinite(r.at);
}

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
 *
 * Every entry names the namespace whose compression it describes, since one
 * process's strategies share the log (#239).
 */
function logCompressionCall(entry: Record<string, unknown>, namespace: string): void {
  const logPath = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const line = JSON.stringify({ ...entry, namespace, timestamp: Date.now() }) + '\n';
    appendFileSync(logPath, line);
  } catch (err) {
    namespaceDiagnostics(() => namespace).warn('compression log write failed:', err);
  }
}

/**
 * How a thrown compression failure bears on the request that failed.
 *
 * - `rejection`: the provider deterministically rejected THIS request (too
 *   long, malformed, refused by policy, or asking for something the model does
 *   not support). Repeating it changes nothing; a ladder may try a different
 *   request, and a completed ladder of such outcomes exhausts the family.
 * - `transient`: capacity, transport, credentials, or anything unclassified.
 *   One says nothing about the request, so by itself it spends no ladder rung
 *   and exhausts no family: the compression lane pauses and the same request
 *   is tried again later. COMPRESSION_PERSISTENT_FAILURES of them on one
 *   rung, counted while other compression lands in their domain, decide that
 *   rung (CompressionFailureStreak).
 * - `abort`: a cancellation, or a host's withdrawal of the call
 *   (CompressionWithdrawn). Neither evidence nor a reason to pause.
 */
type CompressionFailureKind = 'rejection' | 'transient' | 'abort';

function compressionErrorType(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('type' in error)) return undefined;
  const type = (error as { type: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * A failure's class: membrane's error type and HTTP status, or the thrown
 * value's name for an untyped one. It names the pause's latest failure (in
 * checkReadiness()) and a deciding outcome (`persistent-<class>`); it
 * doesn't decide whether a failure counts (see nextFailureStreak).
 */
function compressionFailureClass(error: unknown): string {
  const type = compressionErrorType(error)
    ?? (error instanceof Error ? error.name : error === null ? 'null' : typeof error);
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof status === 'number' ? `${type}:${status}` : type;
}

/** A thrown value's message, always a string, for a health report, which mustn't throw itself. */
function failureMessage(thrown: unknown): string {
  try {
    if (thrown instanceof Error && typeof thrown.message === 'string' && thrown.message) return thrown.message;
    return String(thrown);
  } catch {
    return 'an error that could not be described';
  }
}

/** A thrown value's text on one line, so a line that quotes it stays one line. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

/** The most of a thrown value's text that an operator message quotes as its cause. */
const CAUSE_MAX_CHARS = 180;

/**
 * A thrown value's text as an operator message's cause: on one line, and cut
 * to CAUSE_MAX_CHARS with an ellipsis, never inside a surrogate pair, so the
 * lines after it survive a cut at 500 characters. The whole value is still
 * in the log line that names the failure, and an attempt's error keeps it as
 * its `cause`.
 */
function causeText(thrown: unknown): string {
  const text = oneLine(failureMessage(thrown));
  if (text.length <= CAUSE_MAX_CHARS) return text;
  let end = CAUSE_MAX_CHARS - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/**
 * What an operator reads when the store can't read the compression quarantine
 * ledger: the debt report's `error`, and the error an attempt that would call
 * the model stops with, since it reads the ledger first. A line saying what
 * happened, then its cause, its effect and its fix, so a surface that shows it
 * whole breaks it where a reader looks. With its cause cut to 180
 * characters (causeText) it stays under 500, where connectome-host's status
 * notices and agent-framework's alert webhook cut a message.
 */
function compressionQuarantineUnreadableMessage(cause: unknown): string {
  return [
    'Compression of new conversation has stalled.',
    `Cause: the store couldn't read this agent's compression quarantine ledger (${causeText(cause)}).`,
    'Effect: chunks that need the model go unsummarized, so in time its context fills and its turns fail until compression catches up.',
    'Fix: fix what the cause names; compression then resumes by itself.',
  ].join('\n');
}

/**
 * What an operator reads when the debt report itself fails. Outside the
 * ledger it reads only the strategy's own state and the options it was
 * given, so a throw there is a fault in context-manager or in those options.
 * How to report it is the host's to say.
 */
function compressionDebtReportFailedMessage(cause: unknown): string {
  return [
    'The compression debt report failed.',
    `Cause: ${causeText(cause)}`,
    "Effect: the report can't say whether compression is keeping up. Compression itself may be running normally.",
    'Fix: this points to a fault in context-manager or in the options it was given. Report it.',
  ].join('\n');
}

/**
 * A compression attempt that couldn't read the compression quarantine ledger.
 * An attempt that would call the model reads it first, so while it can't be
 * read each such attempt stops there, and the error says so in the words a
 * host's report of a failed tick shows an operator. The read's own failure is
 * its `cause`.
 */
class CompressionQuarantineUnreadableError extends Error {
  constructor(cause: unknown) {
    super(compressionQuarantineUnreadableMessage(cause), { cause });
    this.name = 'CompressionQuarantineUnreadableError';
  }
}

/**
 * Whether a merge group still stands as it was recorded: every source present
 * and unparented. The sweep removes a merge-quarantine record once it
 * doesn't, the debt report counts a topology refusal only while it does, and
 * a record neither holds its sources nor is retried or cleared by a valid
 * merge of its group while it doesn't. A record of no sources stands: it is
 * the refusal of the empty group mergeThreshold 0 queues (#285), and while it
 * stands, enqueueMerge() keeps that group from being queued again.
 */
function mergeRecordStands(
  record: Pick<MergeQuarantineRecord, 'sourceIds'>,
  summaryById: (id: string) => SummaryEntry | undefined,
): boolean {
  return record.sourceIds.every((id) => {
    const summary = summaryById(id);
    return summary !== undefined && !getSummaryParentId(summary);
  });
}

/** A no-call refusal by the caller's provider admission: nothing failed. */
function isAdmissionDeferral(error: unknown): boolean {
  return (error as { providerAdmission?: unknown } | null)?.providerAdmission === 'deferred';
}

/**
 * The comparison domain of a compression call: the membrane instance it went
 * through and the model it named, as this process knows them. A failure is
 * evidence about its request only against other compressions that landed in
 * the same domain: another model's or another route's successes say nothing
 * about whether this one answers. A membrane instance has no identity of its
 * own, so each gets a token minted here. Strategies that share a membrane
 * instance share its domains. Routing below membrane, such as a proxy that
 * picks a backend per call, is invisible here. The design assumes a
 * long-lived membrane instance: a host that builds one per call gives every
 * failure a domain of its own, so no run reaches a second failure and the
 * run rule decides nothing (a failure whose kind decides it still does); a
 * chunk failing that way shows in getCompressionDebt, not in the quarantine
 * count.
 */
let compressionDomainTokens = 0;
const membraneDomainTokens = new WeakMap<object, string>();
/** Compressions landed per membrane instance and model in this process. */
const domainLandings = new WeakMap<object, Map<string, number>>();

function compressionDomain(membrane: object, model: string | undefined): string {
  let token = membraneDomainTokens.get(membrane);
  if (token === undefined) {
    token = `${++compressionDomainTokens}`;
    membraneDomainTokens.set(membrane, token);
  }
  return `${token}\u0000${model ?? ''}`;
}

function domainLanded(membrane: object, model: string | undefined): number {
  return domainLandings.get(membrane)?.get(model ?? '') ?? 0;
}

/** A landing in its domain (see AutobiographicalStrategy's noteCompressionLanded). */
function noteDomainLanding(membrane: object, model: string | undefined): void {
  let byModel = domainLandings.get(membrane);
  if (!byModel) {
    byModel = new Map();
    domainLandings.set(membrane, byModel);
  }
  byModel.set(model ?? '', (byModel.get(model ?? '') ?? 0) + 1);
}

/**
 * A run of failures that did not decide their request by their kind (see
 * compressionFailureKind), of one subject: an L1 chunk's rung (chunkRunKey)
 * or a queued merge. Such a failure is evidence about its subject only while
 * its domain works otherwise: it is counted when some other compression has
 * landed in the same domain since the subject last failed there. An outage
 * fails everything, so nothing lands and nothing is counted; a subject that
 * keeps failing while other work lands on its route and model is failing on
 * its own, and COMPRESSION_PERSISTENT_FAILURES of them decide it. Runs live
 * in the process (compressionFailureRuns, mergeFailureRuns), as their
 * evidence does: landings are counted per membrane instance, which nothing
 * identifies across a restart.
 */
interface CompressionFailureStreak {
  /** The run's subject: chunkRunKey for an L1 rung, the merge's identity for a merge. */
  key: string;
  /** The domain its failures came from (compressionDomain): another starts a new run. */
  domain: string;
  /** Failures in the run (the first included). */
  failures: number;
  /** Its domain's landed count at the request's last failure. */
  atLanded: number;
}

/**
 * The run after one more failure of `key` in `domain`, whose landed count is
 * `landed`. The first failure of a subject, or its first in another domain,
 * starts a run of one. A later one extends the run only if other work has
 * landed in the domain since the last one, whatever its class; otherwise it
 * says nothing new (the route may be down) and the run keeps its count. The
 * eighth failure in a run is therefore the first and seven more, each
 * separated from the one before by a landing.
 */
function nextFailureStreak(
  previous: CompressionFailureStreak | undefined,
  key: string,
  domain: string,
  landed: number,
): CompressionFailureStreak {
  if (!previous || previous.key !== key || previous.domain !== domain) {
    return { key, domain, failures: 1, atLanded: landed };
  }
  if (landed <= previous.atLanded) return previous;
  return { ...previous, failures: previous.failures + 1, atLanded: landed };
}

/**
 * An L1 run's subject: the chunk's rung, by the chunk's sources (see
 * chunkRunSubject) and the rung's curve label, the stripped retry after a
 * carrier rejection being its own. Not the request's bytes: a pending
 * chunk's request carries the unmerged frontier summaries that start before
 * it as recall pairs, so an L1 that lands for history before it changes it,
 * and those landings are the evidence a run needs.
 */
function chunkRunKey(runSubject: string, curveLabel: string, stripped: boolean): string {
  return sha256Json({ runSubject, curveLabel, stripped });
}

/**
 * When a chunk closed: the newest of its messages' timestamps, in ms. A live
 * message carries a Date and a serialized one a number, which may be in µs.
 * Undefined when no message carries a timestamp.
 */
function chunkClosedAtMs(messages: readonly unknown[]): number | undefined {
  let newest: number | undefined;
  for (const message of messages) {
    const t = (message as { timestamp?: number | Date }).timestamp;
    const raw = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : undefined;
    // An invalid Date's NaN would win no comparison and stick as the close time.
    if (raw === undefined || Number.isNaN(raw)) continue;
    const ms = raw > 1e14 ? raw / 1000 : raw;
    if (newest === undefined || ms > newest) newest = ms;
  }
  return newest;
}

/**
 * The sources an L1 run's failures were about: the chunk's message ids and
 * their content. A source edited in place keeps its id but is a different
 * request, so its failures start a run of their own.
 */
function chunkRunSubject(chunkSourceHash: string, messages: readonly { content: unknown }[]): string {
  return sha256Json({ chunkSourceHash, content: messages.map((message) => message.content) });
}

/** A queued merge's identity in the lane's failure order. */
function mergeFailureKey(merge: { level: number; sourceIds: readonly string[] }): string {
  return `${merge.level}\u0000${merge.sourceIds.join('\u0000')}`;
}

function compressionFailureKind(error: unknown): CompressionFailureKind {
  // A host's withdrawal is no outcome of the call, as an abort is none: it is
  // rethrown with nothing recorded, and the work keeps its place.
  if (isCompressionWithdrawn(error)) return 'abort';
  if (error instanceof Error && error.name === 'AbortError') return 'abort';
  const type = compressionErrorType(error);
  if (type === 'abort') return 'abort';
  if (type === 'context_length' || type === 'invalid_request' || type === 'safety' || type === 'unsupported') {
    return 'rejection';
  }
  return 'transient';
}

/** Longest failure text a compression log line carries. */
const COMPRESSION_FAILURE_LOG_MAX_CHARS = 2_000;

/**
 * `text` when it fits; otherwise its head and tail around a marker stating
 * how many of how many characters were omitted, the whole within `max`.
 * Cuts move only toward omission, so no surrogate pair is split.
 */
export function boundFailureLogText(text: string, max = COMPRESSION_FAILURE_LOG_MAX_CHARS): string {
  if (text.length <= max) return text;
  const isLow = (index: number): boolean => {
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  const marker = ` …[${text.length} of ${text.length} characters omitted]… `.length;
  const budget = Math.max(0, max - marker);
  const tail = Math.floor(budget / 4);
  let headEnd = budget - tail;
  if (headEnd > 0 && isLow(headEnd)) headEnd--;
  let tailStart = text.length - tail;
  if (tailStart < text.length && isLow(tailStart)) tailStart++;
  return `${text.slice(0, headEnd)} …[${tailStart - headEnd} of ${text.length} characters omitted]… ${text.slice(tailStart)}`;
}

/**
 * A bounded string describing a compression failure, on one line, for logs
 * that would otherwise print the error object. A provider error carries the whole
 * request that failed (`rawRequest`); printing the object prints it, and a
 * provider can echo the request in the message too. Every part is bounded.
 */
function describeCompressionFailure(error: unknown): string {
  try {
    if (!(error instanceof Error)) return boundFailureLogText(oneLine(String(error)));
    const fields = error as Error & { httpStatus?: unknown; providerErrorCode?: unknown; retryable?: unknown };
    const type = compressionErrorType(error);
    const classification = [
      type !== undefined ? boundFailureLogText(type, 128) : undefined,
      typeof fields.httpStatus === 'number' ? `HTTP ${fields.httpStatus}` : undefined,
      typeof fields.providerErrorCode === 'string' ? boundFailureLogText(fields.providerErrorCode, 128) : undefined,
      typeof fields.retryable === 'boolean' ? `retryable=${fields.retryable}` : undefined,
    ].filter((part): part is string => part !== undefined);
    const name = boundFailureLogText(String(error.name), 128);
    const head = classification.length > 0 ? `${name} (${classification.join(', ')})` : name;
    return boundFailureLogText(`${head}: ${boundFailureLogText(oneLine(String(error.message)))}`);
  } catch {
    return '[failure could not be described]';
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
 * The interstitial text between two summaries in the legacy combined recall
 * answer (`positionedRecallPairs: false`). Hoisted out of
 * `renderCombinedRecallAnswer` because the shared-budget path must PRICE it
 * before deciding whether the next summary can be admitted, and the tests that
 * pin that arithmetic derive their caps from this same string: one source of
 * truth for the separator's bytes, and therefore for its cost.
 */
export const COMBINED_RECALL_SEPARATOR_TEXT = '\n\n---\n\n';

/**
 * The Context Manager's turn between a recall answer and the agent's own raw
 * turn right after it, in a compression or merge prompt (#116 review, R3-1).
 * A recall answer is the agent's turn, so the agent's next turn would join
 * it: `collapseConsecutiveMessages` merges consecutive messages of one
 * participant, and the formatter merges consecutive messages of one role at
 * the wire. The summarizer would then read that turn as the end of the memory
 * it had just recalled, and the answer would no longer be the exact body the
 * recall-curve variants look for. This turn ends the recall, so the raw turn
 * after it reads as the conversation going on. Only a request with that
 * adjacency carries it (`separateRecallAnswers`).
 */
export const RECALL_RESUME_TEXT = '[CM] The conversation resumes.';

/** The message an entry ends on: a composite's last source, or its one source.
 *  For a body the head and the recent window share, that's a recent message. */
function lastSourceOf(entry: ContextEntry): MessageId | undefined {
  return entry.sourceMessageIds?.at(-1) ?? entry.sourceMessageId;
}

/** The summary id a `[CM] Recall memory <id>.` header names, or undefined for
 *  any other message. A recall pair is such a header and the answer after it. */
function recallHeaderId(message: { participant: string; content: ContentBlock[] }): string | undefined {
  if (message.participant !== 'Context Manager' || message.content.length !== 1) return undefined;
  const block = message.content[0];
  if (block?.type !== 'text') return undefined;
  return /^\[CM\] Recall memory (.+)\.$/.exec(block.text)?.[1];
}

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

/** Messages with `line` appended to the final message's last block, when that
 *  block is text. */
function withLineAppended<M extends { content: ContentBlock[] }>(messages: readonly M[], line: string): M[] {
  return messages.map((m, i) => {
    if (i !== messages.length - 1) return m;
    const content = m.content.map((block, j) =>
      j === m.content.length - 1 && block.type === 'text'
        ? { ...block, text: block.text + line }
        : block,
    );
    return { ...m, content };
  });
}

/** Clone a compression request with `line` appended to the final instruction message. */
function withAppendedInstruction(request: NormalizedRequest, line: string): NormalizedRequest {
  return { ...request, messages: withLineAppended(request.messages, line) };
}

/** The lines a retry of an L1 compression appends to its instruction. */
const L1_RETRY_LINES = [NO_TOOLS_RETRY_LINE, PLAIN_PROSE_RETRY_LINE] as const;

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
/**
 * Summarizer models on which a request carrying the compression marker and
 * directive but NO `tools` param is a deterministic reasoning_extraction
 * input-block regardless of chunk content (measured: claude-fable-5-1 and
 * claude-fable-5, 2026-09-05 — bare marker+directive IB 3/3, identical bytes
 * with the live tool set end_turn 3/3). Prefix-matched; gateway-prefixed ids
 * ('anthropic/claude-fable-5'), Bedrock dot/colon-prefixed ids, and dated
 * snapshots are covered.
 */
export function isToolsLessRefusingSummarizer(model: string): boolean {
  return /(?:^|[\/.:])claude-(?:fable|mythos)-/.test(model);
}

function withoutToolsParam(request: NormalizedRequest): NormalizedRequest {
  const { tools: _tools, ...rest } = request as NormalizedRequest & { tools?: unknown };
  return rest as NormalizedRequest;
}

/** Whether a message's content, as stored, holds a tool call or a tool result. */
function hasToolBlocks(content: readonly ContentBlock[]): boolean {
  return content.some((block) => block.type === 'tool_use' || block.type === 'tool_result');
}

/** A tool-pruning decision (AutobiographicalStrategy.toolPruning), as the
 *  strategy's private members hold it. */
type ToolPruningDecision = {
  readonly replaced: ReadonlyMap<MessageId, ReadonlyMap<number, string>>;
  readonly inputCap: number;
};

/** A tool call the conversation answers: its message's place in the listing,
 *  the place of the result that first answered it, and every result that
 *  answers it, by message and place in its content. */
type AnsweredCall = { message: number; place: number; results: Array<{ message: MessageId; index: number }> };

/**
 * Each tool's answered calls, as toolPruning counts them. A result answers
 * the earliest call with its id, in an earlier message, that no result has
 * answered yet; a result with no such call goes with the call its id last
 * answered, as a further result; a result with neither answers none. Epoch
 * 4's predicate reads the same calls, so it sees what the count sees.
 */
function answeredToolCalls(messages: readonly StoredMessage[]): Map<string, AnsweredCall[]> {
  type Waiting = { toolName: string; call: AnsweredCall };
  // Calls no result has answered yet, oldest first, by id, and the call
  // each id's latest first answer went to.
  const waiting = new Map<string, Waiting[]>();
  const answeredLast = new Map<string, AnsweredCall>();
  const byTool = new Map<string, AnsweredCall[]>();
  let place = 0;
  for (let at = 0; at < messages.length; at++) {
    const m = messages[at]!;
    // A message's calls wait from the next message on: pairing repair
    // drops a result in its call's own message.
    const opened: Array<[string, Waiting]> = [];
    for (let i = 0; i < m.content.length; i++, place++) {
      const block = m.content[i]!;
      if (block.type === 'tool_use') {
        opened.push([block.id, { toolName: block.name, call: { message: at, place: -1, results: [] } }]);
      } else if (block.type === 'tool_result') {
        const first = waiting.get(block.toolUseId)?.shift();
        let call: AnsweredCall | undefined;
        if (first) {
          call = first.call;
          call.place = place;
          answeredLast.set(block.toolUseId, call);
          let answered = byTool.get(first.toolName);
          if (!answered) byTool.set(first.toolName, (answered = []));
          answered.push(call);
        } else {
          call = answeredLast.get(block.toolUseId);
        }
        call?.results.push({ message: m.id, index: i });
      }
    }
    for (const [id, entry] of opened) {
      let queue = waiting.get(id);
      if (!queue) waiting.set(id, (queue = []));
      queue.push(entry);
    }
  }
  return byTool;
}

/** Whether two messages' replacements (each result's place and marker) are
 *  the same; two absent ones are. */
function sameMarkers(a: ReadonlyMap<number, string> | undefined, b: ReadonlyMap<number, string> | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  for (const [index, marker] of b) if (a.get(index) !== marker) return false;
  return true;
}

/** `block` with its input truncated, when its serialized input is over
 *  `cap` tokens (`toolUseInputMaxTokens`), at four characters a token: the
 *  input becomes `{ _truncated, _originalTokens, _keys }`, `_keys` holding
 *  its first five keys. Null when the input fits. */
function truncatedToolUse(block: Extract<ContentBlock, { type: 'tool_use' }>, cap: number): ContentBlock | null {
  const inputTokens = Math.ceil(JSON.stringify(block.input).length / 4);
  if (inputTokens <= cap) return null;
  return {
    ...block,
    input: { _truncated: true, _originalTokens: inputTokens, _keys: Object.keys(block.input).slice(0, 5) },
  };
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

/**
 * Durable progress through one L1 request family's ladder: what each request
 * already tried has deterministically answered, so a ladder interrupted by a
 * transient failure resumes at the interrupted rung instead of paying again
 * for requests whose outcome is known, or exhausting a viable family.
 * Split-stitch is one unit: a transient failure inside it re-runs the whole
 * rung, the pieces it had settled included.
 *
 * Kept separate from the quarantine ledger, whose projection IS the
 * quarantined set (status and the klaxon count it). Branch-scoped like the
 * rest of the strategy's state. Deleted at meaningful boundaries only: the
 * chunk mints or its span is otherwise covered, the family exhausts into
 * quarantine or an operator clears that quarantine, or the tick's sweep finds
 * the span paid off or the progress abandoned (sweepPaidOffCompressionProgress).
 */
interface CompressionFamilyProgress {
  familyKey: string;
  chunkSourceHash: string;
  /** The chunk's message ids, whose hash is chunkSourceHash. Absent on entries written before it was added. */
  sourceIds?: string[];
  /** Deterministic outcomes observed so far, by curveLabel and requestHash. */
  outcomes: CompressionRefusalOutcomeRecord[];
  /** The canonical's input tokens as the provider counted them, when it answered:
   *  the fallback plan is recomputed from them. */
  canonicalProviderInputTokens?: number;
  /** source-only-final's input tokens as the provider counted them, when it
   *  answered: its hoist's admission is priced from them, so a resumed ladder
   *  admits that hoist as it did before. Absent on entries written before it
   *  was added. */
  sourceOnlyProviderInputTokens?: number;
  updated: number;
}

/**
 * In-process pacing of the compression lane after a failure that says
 * nothing about the request (see compressionFailureKind). Scoped to the
 * membrane instance and compression model it was observed on: a different
 * provider or model ignores and clears it. A durable, restart-stable provider
 * deadline is the caller's (agent-framework's provider admission).
 */
interface CompressionLanePause {
  /** The lane's own backoff: 5 s doubling per failure, capped at 10 min. */
  backoffUntil: number;
  /**
   * The external constraint, kept apart from the backoff so a release of it
   * leaves the lane's own pacing in place. Null when none, or once released.
   * - A provider's stated wait after a real failed call: its instant, or
   *   Infinity when it cannot be held as one (an explicit hold until a
   *   restart, a change of membrane or model, or releaseCompressionPause).
   * - A no-call deferral by the caller's provider admission: when to ask the
   *   admission again, its deadline or COMPRESSION_ADMISSION_RECHECK_MS,
   *   whichever is sooner. Always finite: a cached admission answer, not a
   *   provider deadline.
   */
  statedUntil: number | null;
  /**
   * Whose word `statedUntil` is: the provider's (a failed call's stated
   * wait), or the caller's provider admission (it deferred the call, so no
   * call was made). Null with `statedUntil`.
   */
  statedBy: 'provider' | 'admission' | null;
  /**
   * The deadline the caller's provider admission last gave while it holds
   * the lane (null: it gave none), so one hold warns and logs once, and again
   * only when its deadline changes. Unset on a pause no admission holds, and
   * cleared by releaseCompressionPause.
   */
  admissionDeadline?: number | null;
  /** Consecutive paused failures; resets on any provider answer. */
  failures: number;
  membrane: unknown;
  /** The model of the call that failed (not the configured model at the time of the failure). */
  model: string | undefined;
  reason: string;
  /**
   * What failed last and its class (compressionFailureClass), which
   * checkReadiness names; unset on a hold by the caller's admission.
   */
  latest?: { subject: string; failureClass: string };
}

/** The last instant a JavaScript Date can represent (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;
/** When the lane may call again: the later of its two constraints. */
const pauseUntil = (pause: CompressionLanePause): number => Math.max(pause.backoffUntil, pause.statedUntil ?? 0);
/** Which constraint binds: the provider's stated wait only when it outlasts the backoff. */
const pauseSource = (pause: CompressionLanePause): 'retry-after' | 'backoff' =>
  pause.statedUntil !== null && pause.statedUntil > pause.backoffUntil ? 'retry-after' : 'backoff';
const pauseSourceText = (pause: CompressionLanePause): string =>
  pauseSource(pause) === 'retry-after'
    ? (pause.statedBy === 'admission' ? "then the caller's provider admission is asked again" : "the provider's stated wait")
    : 'backoff';
const pauseUntilText = (pause: CompressionLanePause): string => {
  const until = pauseUntil(pause);
  if (Number.isFinite(until)) return `until ${new Date(until).toISOString()}`;
  return 'until a restart, a change of model, or an explicit release (the provider stated a wait that cannot be held as an instant)';
};
/**
 * The model each failed compression call was dispatched with, keyed by its
 * error: the pause describes the call that failed, even if the configured
 * compression model changed while it was in flight.
 */
const dispatchedCompressionModel = new WeakMap<object, string>();
/**
 * The hash of the request each failed L1 call actually dispatched, keyed by
 * its error. A rung's outcome keeps the rung's identity, but after a carrier
 * rejection the rung dispatches its stripped request, whose failures are a
 * run of their own (chunkRunKey).
 */
const dispatchedRequestHash = new WeakMap<object, string>();
function noteDispatchedModel(error: unknown, request: NormalizedRequest): void {
  const model = (request.config as { model?: unknown } | undefined)?.model;
  if (error !== null && typeof error === 'object' && typeof model === 'string') dispatchedCompressionModel.set(error, model);
}

interface CompressionRefusalNormalizedConfig {
  accountingVersion: number;
  fallbackLimit: number;
  contextBudgetTokens: number;
  requestConfig: NormalizedRequest['config'];
  sourceOnlyFallbackEnabled?: boolean;
  sourceOnlyFallbackRequestHash?: string;
  /** Normalized tool-prose hoist options; absent when the rung is off. */
  toolProseFallback?: ToolProseHoistOptions;
}

type CompressionAttemptOutcome =
  | 'refusal'
  /** The merge group is not contiguous in store order; refused before any model call. */
  | 'topology_violation'
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
/**
 * A merge whose answer a compression hold placed on its span during the call
 * keeps out. The provider answered, so it is no failure: the entry stays
 * queued for the hold's release, and nothing is counted or paused.
 */
class MergeHoldDiscard extends Error {
  override name = 'MergeHoldDiscard';
}

/**
 * The split-stitch rung waits for its call window (at most
 * compressionSplitMaxCallsPer10Min calls in ten minutes, per strategy
 * instance) to have room for a whole attempt. A local throttle is no answer
 * and no failure: nothing is recorded or counted, the lane isn't paused, and
 * the chunk waits `waitMs` while other work runs. `window` names the
 * instance whose window it is: only that instance's tick holds the chunk for
 * the wait. An instance that joined the call rethrows the wait and holds
 * nothing: its next attempt is its own, and its split rung meets its own
 * window.
 */
class CompressionSplitWindowWait extends Error {
  override name = 'CompressionSplitWindowWait';
  constructor(readonly waitMs: number, used: number, limit: number, readonly window: symbol) {
    super(`split-stitch waits for its call window: ${used} of ${limit} calls in the last 10 minutes`);
  }
}

/** A deferral that made no call: the caller's admission refused it, or the split rung's window had no room. */
function isNoCallDeferral(error: unknown): boolean {
  return isAdmissionDeferral(error) || error instanceof CompressionSplitWindowWait;
}

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
 * policy, or refused for its topology. Keyed by sha256 of the sourceIds
 * list. While a record whose merge the provider kept refusing or failing is
 * live, `enqueueMerge` refuses the same source set, and the record holds its
 * sources out of every merge while its group could be retried as it stands
 * (mergeRecordHolds), so merges form around them — the debt is surfaced by
 * the merge-quarantine klaxon instead of being retried in a loop. Cleared by
 * operator action (`clearMergeQuarantine`, which retries a held group) or
 * swept automatically once any source is covered by a parent or gone; a
 * topology refusal's record holds nothing, and goes once its group is a
 * valid merge again and queues (enqueueMerge).
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

/** One summary whose leaves are not contiguous among chunk-owned messages. */
export interface TopologyViolation {
  id: string;
  level: number;
  leafCount: number;
  /** First/last leaf message id in store order. */
  span: { first: string; last: string };
  /** Chunk-owned messages inside the span that the summary does not own. */
  holes: number;
  /** Up to five hole message ids. */
  holeSample: string[];
  /** Up to five L1 summaries that own the holes (the interleaved representation). */
  holeOwners: string[];
}

/**
 * Thrown by `initialize` (so by `ContextManager.open`) when the summary
 * archive carries crossed ownership and `topologyPolicy` is `'reject'`.
 * The store is intact; nothing was written. Repair it (or open with
 * `topologyPolicy: 'report'` to inspect) before running a resident on it.
 */
export class StoreTopologyError extends Error {
  constructor(readonly violations: TopologyViolation[]) {
    super(
      `store topology rejected: ${violations.length} summar${violations.length === 1 ? 'y owns' : 'ies own'} ` +
        `non-contiguous leaves — ` +
        violations.slice(0, 8).map((v) =>
          `L${v.level} ${v.id} (${v.leafCount} leaves ${v.span.first}..${v.span.last}, ${v.holes} hole(s)` +
          `${v.holeOwners.length ? ` owned by ${v.holeOwners.join('/')}` : ''})`).join('; ') +
        (violations.length > 8 ? `; +${violations.length - 8} more` : '') +
        `. Repair the store or set topologyPolicy: 'report' to open it for inspection.`,
    );
    this.name = 'StoreTopologyError';
  }
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

/** The canonical stage's rungs: the canonical request and its tool_use retries. */
const CANONICAL_STAGE_LABELS = new Set(['canonical', 'canonical-no-tools', 'canonical-toolless']);

/**
 * A rung decided by its failures (COMPRESSION_PERSISTENT_FAILURES transient
 * failures, the first and each later one after a landing): the policy's
 * outcome, `persistent-<class>`, not an answer any provider gave.
 */
function isFailureDecision(entry: { outcome: string; errorType?: string }): boolean {
  return entry.outcome === 'provider_error' && typeof entry.errorType === 'string' && entry.errorType.startsWith('persistent-');
}

/** One request's admission against compressionContextBudgetTokens (see compressionAdmission). */
interface CompressionAdmission {
  expansionDeltaTokens: number;
  boundedInputTokens: number;
  outputReserveTokens: number;
  admittedTokens: number;
  budgetTokens: number;
  disposition: 'provider_attempt' | 'admission_rejected';
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

/**
 * Whether a ledger value can stand as a quarantine record: an object with a
 * string key and chunk hash, which name the entry and its span. Every reader
 * of an active entry takes its record as given, and the ledger is read back
 * from the store unchecked, so a value edited or damaged there can be
 * anything.
 */
function isUsableQuarantineRecord(record: unknown): record is CompressionRefusalQuarantineRecord {
  return typeof record === 'object' && record !== null &&
    typeof (record as { key?: unknown }).key === 'string' &&
    typeof (record as { chunkSourceHash?: unknown }).chunkSourceHash === 'string';
}

/** A quarantine entry's outcomes as read back from the ledger: the objects in a list that carry a string `outcome`, and nothing else. */
function outcomeList(value: unknown): CompressionRefusalOutcomeRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is CompressionRefusalOutcomeRecord =>
      typeof entry === 'object' && entry !== null && typeof (entry as { outcome?: unknown }).outcome === 'string')
    : [];
}

/**
 * Whether a ledger value can stand as an entry's generation: a non-empty
 * string, as every writer makes one (an event id chronicle assigns, or
 * `legacy:<key>`). Clears and alerts find an entry by comparing generations
 * with `===`, which a value read back as an object could never satisfy.
 */
function isUsableGenerationId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
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
  /** The producer's strategy generation moved (a detach or a
   *  reinitialization) before it settled. It may have written nothing, so a
   *  waiter still current that finds neither an L1 nor a quarantine of the
   *  request family hands the chunk back to its tick (onJoinedWorkDiscarded),
   *  to start at a later scan. */
  discarded?: boolean;
  /** The membrane the producer's failed call went through: a wait the provider stated binds that route alone. */
  membrane?: unknown;
}

/** What preparing a compression request replaced in it. */
interface PreparationCounts {
  serializedMediaReplacements: number;
  imageReplacements: number;
  imageBudgetBytes: number;
  imageBytesKept: number;
}

/** A compression request after preparation, with what preparation replaced. */
interface CompressionPreparation extends PreparationCounts {
  request: NormalizedRequest;
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

/** What kv-unified's cache check rebuilt at a compile's solve, for the
 *  compile's record to compare against what it sent (kvUnifiedSelfCheck):
 *  the reference's layout, the identities its markers end on, and each one's
 *  prefix hash in the rebuild. */
interface KvUnifiedRebuilt {
  layout: RenderLayout;
  wanted: Set<string>;
  hashes: Map<string, string>;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Sources as readers iterate them: a non-empty list of ids. Every index is
 * read, since `every` skips an empty slot of a sparse array, which the store
 * can't write.
 */
function isIdList(ids: unknown): ids is string[] {
  if (!Array.isArray(ids) || ids.length === 0) return false;
  for (let i = 0; i < ids.length; i++) {
    const id: unknown = ids[i];
    if (typeof id !== 'string' || id.length === 0) return false;
  }
  return true;
}

/** A range as readers dereference it: its first and last message ids. */
function isReadableRange(range: unknown): range is { first: string; last: string } {
  const ends = range as { first?: unknown; last?: unknown } | null | undefined;
  const first = ends?.first;
  const last = ends?.last;
  return typeof first === 'string' && first.length > 0 && typeof last === 'string' && last.length > 0;
}

/** Text a recall or a merge can carry. */
function hasSummaryText(summary: SummaryEntry): boolean {
  return typeof summary.content === 'string' && summary.content.trim().length > 0;
}

/**
 * Why readers can't use a summary's sources, or above L1 its range, as it
 * holds them, or null. By the open's predicates, sources must be a non-empty
 * list of ids at every level, and above L1 the range two ids. The open drops
 * a summary without them unless another copy has them or, for an L1, the
 * compressed chunk record naming it does. A write has neither: the summary
 * was just minted, and the package's L1 writers mark that record only after
 * the push. An L1's range is its sources' ends, whatever it holds.
 */
function unreadableSourcesOrRange(summary: SummaryEntry): string | null {
  const ids: unknown = summary.sourceIds;
  const range: unknown = summary.sourceRange;
  if (!isIdList(ids)) return `its sourceIds is ${JSON.stringify(ids)}, where readers need a non-empty list of ids`;
  if (summary.level !== 1 && !isReadableRange(range)) {
    return `its sourceRange is ${JSON.stringify(range)}, where readers need two message ids`;
  }
  return null;
}

/**
 * The level a message is planned from: its saved level when the summaries
 * over it reach that level, else the deepest one at or below it that they
 * reach, walking up from its L1. A saved level names a summary's level, and
 * the load repair can drop that summary while the message's L1 survives. The
 * greedy solvers never lower a level and price one with no summary as raw,
 * so such a message stayed raw, and a compile that its L1 would have fit
 * failed.
 */
function reachableLevel(saved: number, l1Id: SummaryId | undefined, summariesById: ReadonlyMap<SummaryId, SummaryEntry>): number {
  // Every parent sits above its summary: the load repair keeps no other, a
  // merge names the summary it wrote a level up, and the live lookup reloads
  // rather than adopt stored pointers. So the walk climbs and ends.
  let level = 0;
  let current = l1Id === undefined ? undefined : summariesById.get(l1Id);
  while (current && current.level <= saved) {
    level = current.level;
    const parentId = getSummaryParentId(current);
    current = parentId ? summariesById.get(parentId) : undefined;
  }
  return level;
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

/** The fold bound a pinned message position resolves to (the strategy's
 *  `resolvedPinBounds`): raw, a fixed level, or a depth cap. */
export type ResolvedPinBound = 'raw' | { level: number } | { maxLevel: number };

/**
 * Drop empty text blocks (`{type:'text', text:''}` or whitespace-only). The
 * Anthropic API rejects them with 400 "text content blocks must be non-empty",
 * which — thrown inside the speculative-compression drain — halts ALL
 * compression. Non-text blocks (tool_use/tool_result/image) pass through
 * unchanged, so tool pairing is preserved; callers drop any message left with
 * an empty content array. membrane's zero-width carriers of opaque Responses
 * items (a compaction item, a hosted tool's call) are empty text too, so they
 * are dropped from compression requests as well, as they always were.
 *
 * Released narrowly (releaseVanishedRawForms, not releaseEditedRawForms): an
 * empty part dropped from a Responses message item while a sibling part
 * survives still rides inside the sibling's raw item, and only whitespace can
 * ship that way, so releasing would re-render the whole item (and its reasoning
 * pairing) from fields for no content change. An item none of whose parts
 * survive is gone from the wire, a dropped carrier's item included, so the
 * reasoning paired with it gives up its id rather than be replayed without its
 * follower.
 *
 * Exported for its tests; not part of the package's API.
 */
export function stripEmptyTextBlocks(content: ContentBlock[]): ContentBlock[] {
  return releaseVanishedRawForms(content, content.filter((b) => {
    if (b.type !== 'text') return true;
    const text = (b as { text?: unknown }).text;
    return typeof text === 'string' && text.trim().length > 0;
  }));
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
 *
 * The blocks are left out as `withoutThinking` leaves them, raw forms
 * included (thinking-binding.ts).
 */
const stripThinkingBlocks = withoutThinking;

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
 * A block as a compression request's route sends it (sentBoundTokens), as
 * membrane 0.5.86 sends it:
 *   - Anthropic: the native formatter rebuilds each block from its fields,
 *     raw forms dropped, except a redacted_thinking block, which it passes on
 *     whole;
 *   - Responses, API mode: membrane uses its openai-responses formatter
 *     whatever formatter the request names (resolveActiveFormatter), which
 *     sends a block's rawItem in its place, any type, once per message for an
 *     item blocks share, and builds the rest from their fields;
 *   - Responses, subscription mode: the native formatter, then
 *     normalizeResponsesInput, which sends a redacted_thinking block's
 *     reasoning item in its place and builds the rest from their fields.
 * A redacted_thinking block carrying a reasoning item comes from a
 * compression model on a Responses route and is replayed there, so it is
 * priced as the item alone, which both of those routes send. Every other
 * block is priced by its fields, its raw replay forms set aside as
 * withoutRawForms sets them aside. No route sends rawXml. An opaque carrier
 * never reaches a compression request: compression input drops it with the
 * other empty text (stripEmptyTextBlocks), and validateRecallCurveRequest
 * refuses one.
 */
function sentForm(block: ContentBlock): ContentBlock {
  const item = (block as { rawItem?: unknown }).rawItem;
  if (block.type === 'redacted_thinking' && item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'reasoning') {
    return { type: block.type, rawItem: item } as unknown as ContentBlock;
  }
  return withoutRawForms(block);
}

const TOP_LEVEL_IMAGES = Symbol('top-level images');
/** Which of its message's image groups a block's images belong to, for the
 *  verdicts postStripEstimates keeps: a tool result's are its call's, and a
 *  message's top-level images are one group. */
function imageGroup(block: ContentBlock): unknown {
  return block.type === 'tool_result' ? block.toolUseId : TOP_LEVEL_IMAGES;
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
  /** History renders raw, through summaries, or (uncovered) not at all. */
  readonly renderedForms: ReadonlyArray<'raw' | 'summary' | 'omitted'> = ['raw', 'summary', 'omitted'];
  /** Why the last committed select changed resolutions (takeSelectionCause). */
  private pendingSelectionCause: string | undefined;

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
  /**
   * What the compression in flight works on, for compressionWorkQueued: the
   * chunk tick took, whose compressed flag says once its result has landed
   * (set on that object, which a rebuild leaves alone, before the call's own
   * end), or the source summaries of the merge it runs, which tick leaves at
   * the head of the merge queue until it lands.
   * tick sets it before each call and clears it with pendingCompression. A
   * call whose synchronous start finds the branch gone can clear it with the
   * mirrors first (requireLoadedBranch does unless an initializer is still
   * current), and pendingCompression is then set with nothing recorded
   * beside it until tick's finally. A chunk's record is marked `skipped`
   * when its call skips it for the quarantine, which makes no model call;
   * tick's hop after the call keeps it in flight until tick's finally.
   */
  protected pendingCompressionWork: { chunk: Chunk; skipped?: true } | { sourceIds: readonly string[] } | null = null;
  protected compressionQueue: number[] = [];
  /** Once per source chunk on the loaded branch, across queue rebuilds:
   *  cleared with the other branch mirrors, so another branch warns afresh. */
  private warnedQuarantineSkips = new Set<string>();
  /** The context initialize was given; its `tools` getter follows the host's declarations. */
  private hostContext: StrategyContext | null = null;
  protected _compressionCount = 0;
  /**
   * Monotonic counter of queue items consumed by tick(): compression, merges,
   * or stale/quarantined queue cleanup. `driveSpeculativeDrain` recurses
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
  /** The chunk owning each position of the listing the last rebuild saw. */
  private _chunkByPosition: { listing: readonly StoredMessage[]; chunks: (Chunk | undefined)[] } | null = null;
  /** Record-derived chunks of the last rebuild: reused while the listing only
   *  grew, the record list only grew and the token calibration is unchanged. */
  private _recordChunks: {
    listing: readonly StoredMessage[];
    records: ChunkRecord[];
    calibration: number;
    ignoreSize: boolean;
    entries: Array<{ record: ChunkRecord; messages: StoredMessage[]; tokens: number; positions: number[] }>;
  } | null = null;
  /** Static salience per listing position (see selectAdaptive). */
  private _salience: { listing: readonly StoredMessage[]; values: Float64Array } | null = null;
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

  /**
   * Failures of one request in one domain, the first and seven more each
   * after other compression landed there, that decide its rung (an L1
   * ladder's or a merge's): the request is failing on its own while its route
   * works (see CompressionFailureStreak). A week-long fault on one payload
   * (rhys 2026-08-06: 514 identical merge 500s) converges, while an outage, in
   * which nothing lands, never counts. Eight keeps a flapping provider from
   * deciding a viable request by chance: if each call failed independently
   * 30% of the time, a request would see eight failures in a row about
   * 0.007% of the time. A decided L1 family is quarantined until its chunk
   * compresses, the paid-off sweep clears it, an operator does, or its ledger
   * entry is found unusable (projectCompressionQuarantineEvents); a decided
   * merge counts one of its bounded attempts.
   */
  static readonly COMPRESSION_PERSISTENT_FAILURES = 8;
  /** First compression-lane pause after a transient failure; doubles per failure. */
  static readonly COMPRESSION_PAUSE_BASE_MS = 5_000;
  /** Cap on the lane's own backoff. A provider's stated wait is never capped. */
  static readonly COMPRESSION_PAUSE_MAX_BACKOFF_MS = 10 * 60_000;
  /** How long a no-call deferral by the caller's provider admission is
   *  cached before the lane asks the admission again. Asking makes no
   *  provider call (the admission refuses again while its wait binds), so
   *  this bounds a cache, not a provider deadline. */
  static readonly COMPRESSION_ADMISSION_RECHECK_MS = 30_000;
  /** An admission deadline restated within this much of the last one is the
   *  same deadline: it arrives as a relative wait (`retryAfterMs`), so each
   *  restatement lands a little later on this clock. */
  static readonly COMPRESSION_ADMISSION_DEADLINE_SLACK_MS = 1_000;
  /** How often tick sweeps ladder progress that can never be resumed, at most. */
  static readonly COMPRESSION_PROGRESS_SWEEP_INTERVAL_MS = 10 * 60_000;
  /** Ladder progress nothing has advanced for this long is abandoned: the
   *  sweep drops it, whatever its chunk's state. */
  static readonly COMPRESSION_PROGRESS_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

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
  protected mergeQueue: Array<{ level: SummaryLevel; sourceIds: string[]; attempts?: number; lastStopReason?: string; lastOutcome?: string; hadRefusal?: boolean }> = [];

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
  /** stderr lines about this strategy's work, each naming its namespace (#239). */
  protected readonly diag: Diagnostics = namespaceDiagnostics(() => this.ns);
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
      this.diag.error(msg);
      logCompressionCall({ event: "no-compression-model", fatal: true }, this.ns);
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
  protected get kvUnifiedReceiptStateId(): string { return `${this.ns}/kvunified:presentation-receipt`; }
  private kvUnifiedReceipts = new KvUnifiedReceiptChain();
  /** A persisted kv-unified receipt was found while loading under another
   * folding strategy; superseded at this strategy's first presentation. */
  private kvUnifiedReceiptSupersedePending = false;
  private kvUnifiedDraft: {
    leaves: Map<ChunkId, PresentedLeaf>;
    layout: RenderLayout;
    immutablePrefixHash?: string;
    markerUnitIndices: number[];
    render?: CacheRenderRecord;
  } | null = null;
  private kvUnifiedPendingLayout: RenderLayout | null = null;
  private kvUnifiedPendingMarkerUnitIndices: number[] = [];
  private kvUnifiedPendingImmutablePrefixHash: string | null = null;
  private kvUnifiedPendingRender: CacheRenderRecord | null = null;
  /** The accepted cache reference as this compile's solver gets it: the
   *  markers whose prefix has changed in place since it was accepted are left
   *  out (kvUnifiedCacheForSolve). Set by selectAdaptive before buildPicker. */
  private kvUnifiedSolveCache: ProviderCacheReference | null = null;
  /** Content arrays' and blocks' hashes (kvUnifiedEntryFingerprint), by the
   *  object: the store and the passes replace one rather than change it. It
   *  keeps what this compile and the one before fingerprinted, so it follows
   *  the raw population rather than every message the store holds. */
  private kvUnifiedHashes = { current: new Map<object, string>(), previous: new Map<object, string>() };
  /** Whether the check has said once that it couldn't render a recall pair. */
  private kvUnifiedRecallRenderWarned = false;
  /** Whether the self-check has said once that the rebuild differed from what was sent. */
  private kvUnifiedSelfCheckWarned = false;
  /** Set once this strategy has said that an accepted request's cache markers
   * didn't match its compile's (reportKvUnifiedAccepted), so a mismatch that
   * repeats every turn is said once. */
  private kvUnifiedMarkerMismatchReported = false;
  /** Legacy snapshot used by the unapproved first implementation. Read-only. */
  protected get compressionRefusalQuarantineStateId(): string {
    return `${this.ns}/autobio:compression-refusal-quarantine`;
  }
  protected get compressionRefusalQuarantineLedgerStateId(): string {
    return `${this.ns}/autobio:compression-refusal-quarantine-events`;
  }
  protected get compressionFamilyProgressStateId(): string {
    return `${this.ns}/autobio:compression-family-progress`;
  }
  /** In-process pacing after a transient compression failure (see CompressionLanePause). */
  private compressionPause: CompressionLanePause | null = null;
  /**
   * Counts every wholesale re-decision of the compression queue (each
   * rebuild, and each branch-mirror reset). An attempt that fails while the
   * count is unchanged was not superseded, so its chunk goes back; one that
   * changed meanwhile has a newer eligibility decision, which stands.
   */
  private compressionQueueGeneration = 0;
  /**
   * The lane's order of failures in this process: each chunk (by source
   * identity) and each queued merge (by mergeFailureKey) that failed and is
   * still pending maps to the sequence number of its latest failure. A chunk
   * tick skipped for its quarantine takes an order too, as a failure does.
   * Work that failed or was skipped goes behind work that hasn't, least
   * recently first (orderCompressionQueue, and a merge's place in tick). In
   * memory only: a restart tries the queue in its own order again.
   */
  private compressionFailureOrder = new Map<string, number>();
  private mergeFailureOrder = new Map<string, number>();
  private compressionFailureSequence = 0;
  /**
   * The lane's runs of failures (CompressionFailureStreak): an L1 chunk's by
   * its run subject (chunkRunSubject), with its chunk's key, and a queued
   * merge's by mergeFailureKey. An answer or a decision of its rung ends one,
   * whether it came now or is reused from progress, with one exception:
   * split-stitch's outcome reused from progress (knownSplit) ends none, since
   * the family's exhaustion follows it with no call between, and tick ends
   * the chunk's runs where that exhaustion stops the request. An L1 chunk's
   * runs all end where this process won't retry its request
   * (endChunkFailureRuns): tick's skip for its quarantine, the chunk
   * compressed, or its request found or made unable to go (an exhaustion
   * whose record the ledger holds, a joined call whose family the ledger
   * holds, the overlap guard while the overlap stands). Like the failure
   * orders, a run is dropped once its chunk or merge is no longer pending
   * (orderCompressionQueue). A clear lifts a quarantine and ends no run.
   * While a run stands it holds merges around its span (pendingRetrySpans).
   */
  private compressionFailureRuns = new Map<string, { run: CompressionFailureStreak; chunkKey: string }>();
  private mergeFailureRuns = new Map<string, CompressionFailureStreak>();
  /** A chunk whose split-stitch rung waits for its call window, until when (see CompressionSplitWindowWait). */
  private compressionNotBefore = new Map<string, number>();

  /** Branch-scoped projection of the append-only quarantine event ledger. */
  private compressionRefusalQuarantine = new Map<string, ActiveCompressionQuarantine>();
  /** Advanced by endGeneration(): on every initialize, every ContextManager branch switch included, and at detach(). */
  private compressionBranchGeneration = 0;
  /** The controller of each provider call out (callProvider), until the call settles. */
  private readonly callsOut = new Set<AbortController>();
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
  /** The render stats the most recent select() recorded, live or dry
   *  (getLastSelectStats). A dry select's are kept apart from the live ones
   *  getRenderStats() returns. */
  private _lastSelectStats: RenderStats | null = null;
  /** Set while a dry select runs: its chunking persists no chunk record. */
  private _dryRunSelect = false;
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
  private reportEffectiveConfigOnce(namespace: string): void {
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
      namespace,
    }));
  }
  /**
   * Explicit operator escape hatch. A retry remains canonical-first; clearing
   * this state only permits the same as-of request family to be issued again.
   * A cleared family's ladder progress goes with it, so the retry pays for
   * its answers afresh rather than re-exhausting on outcomes recorded before
   * the clear (a crash between exhaustion's ledger write and its progress
   * drop would otherwise leave them).
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
      const cleared = targets.flatMap((target) => {
        const active = current.get(target.key);
        return active?.generationId === target.generationId ? [{ ...target, familyKey: active.record.familyKey }] : [];
      });
      // Progress goes first: a crash before the clear events leaves the
      // quarantine standing for the operator to clear again, never a cleared
      // family whose recorded answers would exhaust it again at once.
      if (cleared.length > 0) {
        const families = new Set(cleared.map((target) => target.familyKey));
        this.forgetCompressionFamilyProgress((entry) => families.has(entry.familyKey));
      }
      for (const target of cleared) {
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
    opts?: { render?: boolean; thinkingBinding?: ThinkingBinding },
  ): PreviewResult {
    this.requireLoadedBranch('previewContext');
    if (this._previewInFlight) {
      throw new Error('previewContext is already running; previews must not overlap');
    }
    this._previewInFlight = true;
    // The config swap below is this method's own to undo. What the dry select
    // leaves for observers (transition status, render stats, calibration),
    // select() puts back for every dry run, whichever of selectAdaptive's
    // OverBudgetError sites throws; any throw is turned into a report below.
    const savedConfig = this.config;
    const savedPicker = this._adaptivePicker;
    const savedHeadCache = this._cachedHeadStartIndex;
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
        const out = this.select(store, log, budget, { dryRun: true, thinkingBinding: opts?.thinkingBinding });
        // Only retained on request: these are full rendered entries and can be
        // megabytes on a large store.
        if (opts?.render) rendered = out;
      } catch (err) {
        if (!(err instanceof OverBudgetError)) throw err;
        // Read through a cast: control-flow narrowing still has this pinned to
        // `undefined` from the reset above, but selectAdaptive may have filled
        // it in before a late render-stage throw.
        const partial = this._lastPreview as PreviewResult | undefined;
        // A plan already over the budget is refused at its gate by the live
        // compile, with the numbers its preview recorded and the plan's list
        // (which the preview gives as this dry run sees it), so a later stage's
        // refusal of this dry run doesn't change the answer: the preview is the
        // plan's, as when nothing later throws.
        if (partial?.fits === false) return partial;
        // Infeasible at this budget. That is an ANSWER, not a failure — it is
        // the whole reason to preview before applying. Report it with the
        // diagnostics that explain which component does not fit.
        return {
          finalTokens: err.actual,
          budgetTokens: err.budget,
          fits: false,
          exhausted: true,
          clearedBy: err.clearedBy,
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
      // Segment breakdown for the hypothetical compile, which select() kept
      // apart from the live one. Lets a caller show the previewed
      // head/middle/tail split without re-deriving it.
      return {
        ...preview,
        ...(opts?.render
          ? { entries: rendered, stats: this._lastSelectStats ?? undefined }
          : {}),
      };
    } finally {
      this.config = savedConfig;
      this._adaptivePicker = savedPicker;
      this._cachedHeadStartIndex = savedHeadCache;
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
   * Lock a message so the adaptive picker won't change its stored resolution.
   * A classic pin (one without a `level` or `maxLevel`) still overrides the
   * lock while it stands: under the greedy solvers and kv-stable, the pinned
   * message renders raw, and its locked level stays stored and returns when
   * the pin is removed. kv-unified treats a pin and a lock as constraints and
   * reports a conflict when they are incompatible. A pin on another part
   * of a message stored in parts doesn't cover a locked part outside the span
   * its ids name (`pinPositions`): there the lock holds, under every solver.
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
    this.reportEffectiveConfigOnce(ctx.namespace);
    // Invalidate the committed identity before touching any branch-scoped
    // mirror. A stale caller must fail closed for the entire initialization
    // interval, not continue using the previously loaded branch.
    this.loadedBranchIdentity = null;
    this.initializingBranchIdentity = null;
    this.endGeneration();
    this.clearBranchMirrors();
    // Damage in the quarantine is named once per load: this load's reads name
    // what they find, on whatever store, namespace and branch it binds to. So
    // is a debt report's failure: a failure that lasts across a branch switch
    // the manager makes (its switchBranch, a fork, setStrategy) is logged
    // again for the new load, and the new load logs no recovery from a
    // failure only an earlier one met. A host that moves the store's branch
    // itself leaves this load in place until the manager initializes it again.
    this.namedDroppedQuarantineKeys.clear();
    this.namedUnlistedQuarantineState.clear();
    this.compressionDebtFailureLogged = null;

    // Bind to the chronicle store + namespace for persistent strategy state.
    this.store = ctx.store;
    this.ns = ctx.namespace;
    // Its tools getter follows the host's declarations (compressionWorkQueued).
    this.hostContext = ctx;
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
      if (abortIfStale()) return;
      if (!this.config.auditOnly) this.sanitizePersistedMergeQueue(ctx.messageStore);
      if (abortIfStale()) return;
      this.assertStoreTopology(messages);
      // Kick the merge ladder for pre-existing unmerged summaries. Normally a
      // compression/merge completion does this, but a store that boots with a
      // backlog above threshold and an empty queue (e.g. after a pyramid
      // repair pruned duplicates and un-merged survivors) would otherwise
      // never start consolidating. Idempotent: already-queued/merged sources
      // are skipped.
      if (abortIfStale()) return;
      if (this.config.hierarchical && !this.chunkRecordsOrphaned && !this.config.auditOnly) {
        // Clear quarantine records whose sources were merged or repaired while
        // the store was closed. Such a record holds nothing (mergeRecordHolds),
        // but getCompressionDebt lists every record's key, and the alarm-driven
        // sweep may not run for a long time.
        this.sweepPaidOffMergeQuarantine();
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

  /**
   * The manager is done with this strategy (ContextStrategy.detach). A new
   * generation fails every compression and merge still in flight at its next
   * isCompressionBranchCurrent() check, so each discards its result instead
   * of writing, and ends the provider calls they have out (endGeneration).
   * The loaded identity no longer matches either, so each entrypoint that
   * requires the loaded branch throws, getSummary() and getStats() among
   * them, and a drain tick already scheduled does nothing. None of these
   * checks reads the store, which the manager may close next. The health
   * reads, such as getCompressionQuarantineStatus(), still never throw.
   * initialize() starts afresh.
   */
  detach(): void {
    this.endGeneration();
  }

  /**
   * Start a new generation, for initialize() and detach(). The work of the
   * one that ends fails its next currency check, and each provider call it
   * has out is cancelled. Membrane rejects the call at once, during the call
   * or in its own wait before a retry, and retries nothing. A host's
   * beforeRequest hook that is running then, or a provider client's wait
   * inside its own retry, as @anthropic-ai/sdk 0.52.0 waits with no signal,
   * isn't interrupted: the call ends when that returns, sending nothing more.
   */
  private endGeneration(): void {
    this.compressionBranchGeneration++;
    for (const call of this.callsOut) call.abort();
  }

  /**
   * `membrane.complete()` for the current generation's work, with a
   * controller of its own kept in callsOut while the call is out, so that
   * the generation's end cancels it. Each site checks its work's currency
   * just before, with nothing awaited between, so the generation is the
   * work's own.
   *
   * A controller per call, not one signal per generation: a generation lasts
   * as long as the session, membrane hands the caller's signal to the adapter
   * as it is when no progress deadline is set, and @anthropic-ai/sdk 0.52.0
   * adds an abort listener to that signal for each request and never removes
   * it (fetchWithTimeout). In a probe, one shared signal held 15 listeners
   * after 15 settled requests, where each per-call signal held one, which
   * goes with its call.
   *
   * A host can end a call too, by a signal it combines with this one in the
   * membrane it handed in. Its cancellation comes back as itself, and each
   * site takes it as compressionFailureKind() does, as an 'abort', once the
   * work's currency check passes: nothing counts it, a compression's or
   * merge's work stays queued, and a transition summary's caller gets the
   * cancellation. That check is what tells it from the generation's own
   * cancellation, since endGeneration() ends the generation before it aborts
   * the calls.
   */
  private async callProvider(membrane: Membrane, request: NormalizedRequest): Promise<NormalizedResponse> {
    const call = new AbortController();
    this.callsOut.add(call);
    try {
      return await membrane.complete(request, { formatter: this.nativeFormatter, signal: call.signal });
    } finally {
      this.callsOut.delete(call);
    }
  }

  /** Drop every branch-derived mirror without touching durable state. */
  private clearBranchMirrors(): void {
    this.chunks = [];
    this.pendingCompression = null;
    this.pendingCompressionWork = null;
    this.compressionQueue = [];
    this.compressionQueueGeneration++;
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
    this.warnedQuarantineSkips.clear();
    this.pins = [];
    this.pinIdCounter = 0;
    this.resolutions.clear();
    this.locked.clear();
    this._adaptivePicker = null;
    this.lastFrontierTokens = undefined;
    this.transitionBlocked = undefined;
    this._rs = null;
    this._lastRenderStats = null;
    this._lastSelectStats = null;
    this._lastCompileEstimate = 0;
    this._storeView = null;
    // Prices memoized over the view just cleared: the next one may estimate otherwise.
    this._answerCostCache.clear();
    this._calibrationArmed = false;
    this._calibration = 1;
    this._calibrationEma = null;
    this._calibrationLoaded = false;
    this._calibrationReset = null;
    this._calibrationProvisional = null;
    this._imageStripReplayMemo = null;
    this._lastKvStable = null;
    this._storeOrder = new Map();
    this._storeOrderSource = [];
    this._chunkByPosition = null;
    this._l1ByMessage = null;
    this._recordChunks = null;
    this._salience = null;
    this._exactL1 = null;
    this._postStripMemo = null;
    this._coverageMemo = null;
    delete this.kvUnifiedReuse.forest;
    delete this.kvUnifiedReuse.tree;
    delete this.kvUnifiedReuse.certificate;
    delete this.kvUnifiedReuse.subtree;
    delete this.kvUnifiedReuse.whatIf;
    this.heldLevelPins.clear();
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
    this.diag.warn(
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
    const payload = storedJson(rec);
    let found = false;
    for (let i = 0; i < stored.length; i++) {
      const item = stored[i] as ChunkRecord | null;
      if (item && item.id === recordId) {
        this.store.editStateItem(this.chunksStateId, i, payload);
        found = true;
      }
    }
    if (!found) {
      this.diag.warn(
        `[autobiographical] markChunkRecordCompressed: ${recordId} not found in persisted chunk log`,
      );
    }
  }

  /**
   * Register the Chronicle state slots this strategy uses. A slot that
   * already exists is kept as it is (see isStateExistsFor). Any other
   * registration failure propagates and stops initialization. Registrations
   * are separate and durable, so the slots registered before the failing one
   * stay registered, and the next start registers the rest.
   */
  protected registerStates(): void {
    if (!this.store) return;
    const store = this.store;
    const registerState = (registration: Parameters<JsStore['registerState']>[0]): void => {
      registerStateIfAbsent(store, registration);
    };
    registerState({
      id: this.summariesStateId,
      strategy: 'append_log',
      deltaSnapshotEvery: 50,
      fullSnapshotEvery: 10,
    });
    if (this.chunkPersistenceEnabled) {
      registerState({
        id: this.chunksStateId,
        strategy: 'append_log',
        deltaSnapshotEvery: 50,
        fullSnapshotEvery: 10,
      });
    }
    if (this.config.foldingStrategy === 'kv-unified') {
      registerState({
        id: this.kvUnifiedReceiptStateId,
        strategy: 'snapshot',
      });
    }
    registerState({
      id: this.counterStateId,
      strategy: 'snapshot',
    });
    registerState({
      id: this.mergeQueueStateId,
      strategy: 'snapshot',
    });
    registerState({
      id: this.mergeQuarantineStateId,
      strategy: 'snapshot',
    });
    registerState({
      id: this.pinsStateId,
      strategy: 'snapshot',
    });
    registerState({
      id: this.calibrationStateId,
      strategy: 'snapshot',
    });
    registerState({
      id: this.compressionRefusalQuarantineLedgerStateId,
      strategy: 'append_log',
      deltaSnapshotEvery: 50,
      fullSnapshotEvery: 10,
    });
    registerState({
      id: this.compressionFamilyProgressStateId,
      strategy: 'snapshot',
    });
    // Adaptive-resolution state slots — only registered when the flag is on
    // so chronicles without the flag don't accumulate unused slots.
    if (this.config.adaptiveResolution) {
      registerState({
        id: this.resolutionsStateId,
        strategy: 'snapshot',
      });
      registerState({
        id: this.locksStateId,
        strategy: 'snapshot',
      });
    }
  }

  /**
   * Take up what another instance sharing the store has written since this
   * one loaded: the persisted summaries, counter and pending merges, as
   * loadPersistedState reads them, with this instance's kv-unified
   * presentation in flight kept as it is (#166). Called by a compression that
   * waited on another instance's in-flight compression of its family, by the
   * live lookup when the store holds an L1 this instance doesn't
   * (findExactL1), and by a merge whose sources the store holds as parented
   * and this instance doesn't (parentedMergeSources). The store's queue of
   * merges replaces this instance's, and may have been written by an
   * instance that hadn't seen this one's later merges, so the threshold pass
   * then queues again whatever the summaries make eligible. The store's merge
   * quarantine replaces this instance's too, less what the load can't read,
   * which it names and writes back without. Each caller has found its branch
   * current.
   */
  private takeUpStoreState(): void {
    this.loadPersistedState({ keepKvUnifiedPresentation: true });
    this.checkMergeThreshold();
  }

  /**
   * Load summaries, counter, and pending merges from chronicle into the
   * in-memory mirrors. Called on every (re)initialize so branch switches
   * pick up the new branch's state, and by takeUpStoreState(), which passes
   * `keepKvUnifiedPresentation`: a kv-unified strategy then keeps its own
   * receipt chain, whose pending submission is never persisted, rather than
   * replacing it from the store, and keeps its draft and pending layout (with
   * the layout's marker indices and immutable prefix hash), which live only in
   * memory, rather than clearing them (#166).
   */
  protected loadPersistedState(options: { keepKvUnifiedPresentation?: boolean } = {}): void {
    // The summaries a load takes up can end an overlap the guard refused, so
    // the next queue build tests those chunks again. The orphaned-records
    // halt and its warning stay as they are: rebuildChunks recomputes the
    // halt, and an open clears both (clearBranchMirrors).
    this._overlapBlocked.clear();
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
    }
    const summaries = this.store.getStateJson(this.summariesStateId);
    const loaded = Array.isArray(summaries) ? (summaries as SummaryEntry[]) : [];
    // Readers need a summary's text, its sources as a list of ids, and its
    // range as two ids: the adaptive picker's L1 index iterates every L1's
    // sources, recall dereferences the range's ends, and empty text can't be
    // recalled or merged. One null `sourceIds` threw on every compile.
    //
    // Copies of one id are one summary. Before setMergedInto resolved its
    // log slot by id, a merge could be written over a neighbour's slot,
    // leaving duplicates whose merge state diverged. The summary keeps the
    // text of a non-empty copy, preferring one whose pointer names a stored
    // summary above it that lists it, and its first copy's position; its
    // parent is resolved across all its copies below.
    const copiesById = new Map<string, SummaryEntry[]>();
    let malformed = 0;
    for (const summary of loaded) {
      if (!summary || typeof summary !== 'object') { malformed++; continue; }
      const copies = copiesById.get(summary.id);
      if (copies) copies.push(summary);
      else copiesById.set(summary.id, [summary]);
    }
    const dupes = loaded.length - malformed - copiesById.size;
    // The counter starts past every summary id the store holds, dropped ones
    // included, and is stored when that raises it, before any repair below
    // removes a summary: no later open then mints a number the store has
    // used. A store whose counter an older version wrote can trail its ids.
    const counter = this.store.getStateJson(this.counterStateId);
    const pastIds = [...copiesById.keys()].reduce((past, id) => {
      const n = Number(/^L\d+-(\d+)$/.exec(id)?.[1]);
      return Number.isFinite(n) && n >= past ? n + 1 : past;
    }, 0);
    const storedCounter = typeof counter === 'number' ? counter : 0;
    this.summaryIdCounter = Math.max(storedCounter, pastIds);
    if (this.summaryIdCounter > storedCounter) {
      this.store.setStateJson(this.counterStateId, this.summaryIdCounter);
      this.diag.warn(`[autobiographical] raised the summary-id counter from ${storedCounter} to ${this.summaryIdCounter}, past the summary ids the store holds`);
    }

    // A compressed chunk record names its L1 and holds the ordered message
    // ids it gives that L1: the ids compression read, unless a repair has
    // retargeted the record since. An uncompressed record proves nothing
    // about a summary.
    const chunkSources = new Map<string, string[]>();
    for (const record of this.chunkRecords) {
      if (record.compressed && record.summaryId && isIdList(record.sourceIds) &&
          !chunkSources.has(record.summaryId)) {
        chunkSources.set(record.summaryId, record.sourceIds);
      }
    }
    const byId = new Map<string, SummaryEntry>();
    const emptyIds: string[] = [];
    const unreadableIds: string[] = [];
    const rebuiltIds: string[] = [];
    // Each dropped summary that holds text, as it was when dropped, with why:
    // what the load-repair report names (loadRepairReport).
    const textDrops = new Map<string, { summary: SummaryEntry; reason: LoadRepairDropReason }>();
    const namesParent = (copy: SummaryEntry, pointer: unknown): boolean =>
      typeof pointer === 'string' && (copiesById.get(pointer) ?? []).some(
        (parent) => parent.level > copy.level && Array.isArray(parent.sourceIds) && parent.sourceIds.includes(copy.id),
      );
    for (const [id, copies] of copiesById) {
      const withText = copies.filter(hasSummaryText);
      let summary = withText.find((copy) => namesParent(copy, copy.parentId) || namesParent(copy, copy.mergedInto)) ?? withText[0];
      if (!summary) { emptyIds.push(id); continue; }
      if (summary.level === 1) {
        // An L1's own sources, else its compressed chunk record's, else a
        // copy's. Its range is their ends, which every L1 writer sets.
        const ids = [summary.sourceIds, chunkSources.get(id), ...copies.map((copy) => copy.sourceIds)].find(isIdList);
        if (!ids) { unreadableIds.push(id); textDrops.set(id, { summary, reason: 'unreadable' }); continue; }
        const range = summary.sourceRange as { first?: unknown; last?: unknown } | undefined;
        if (ids !== summary.sourceIds || range?.first !== ids[0] || range?.last !== ids[ids.length - 1]) {
          summary = { ...summary, sourceIds: [...ids], sourceRange: { first: ids[0]!, last: ids[ids.length - 1]! } };
          rebuiltIds.push(id);
        }
      } else if (!(isIdList(summary.sourceIds) && isReadableRange(summary.sourceRange))) {
        // Above L1 a range's ends are message ids that the sources don't
        // name, so sources and range come together from one copy.
        const donor = copies.find((copy) => isIdList(copy.sourceIds) && isReadableRange(copy.sourceRange));
        if (!donor) { unreadableIds.push(id); textDrops.set(id, { summary, reason: 'unreadable' }); continue; }
        summary = { ...summary, sourceIds: [...donor.sourceIds], sourceRange: { ...donor.sourceRange } };
        rebuiltIds.push(id);
      }
      byId.set(id, summary);
    }

    // A summary above L1 is kept only while every summary it names is kept
    // and sits below it, whatever removed one and whenever: earlier versions
    // dropped empty summaries without their parents, and a parent naming a
    // missing summary covers messages that are rendered, or compressed again,
    // without it. A merge reads summaries below the one it writes, so a
    // summary that lists one at its own level or above wasn't written from
    // it, and two such summaries can list each other, each covering the
    // other's messages. Repeat to a fixed point. Dropping costs the
    // ancestors' text; their surviving sources merge again.
    // A drop's reason comes from its sources' levels as loaded, so it doesn't
    // depend on which summary the pass reaches first.
    const ancestorIds: string[] = [];
    const misplacedIds: string[] = [];
    const loadedLevel = new Map([...copiesById].map(([id, copies]) => [id, (byId.get(id) ?? copies[0]!).level]));
    const notBelow = (summary: SummaryEntry) =>
      summary.sourceIds.some((sourceId) => (loadedLevel.get(sourceId) ?? 0) >= summary.level);
    const dropMissingAndMisplaced = (): void => {
      for (let changed = true; changed;) {
        changed = false;
        for (const [id, summary] of byId) {
          if (!(summary.level > 1) || (!notBelow(summary) && summary.sourceIds.every((sourceId) => byId.has(sourceId)))) continue;
          byId.delete(id);
          const misplaced = notBelow(summary);
          (misplaced ? misplacedIds : ancestorIds).push(id);
          textDrops.set(id, { summary, reason: misplaced ? 'names-not-below' : 'names-missing' });
          changed = true;
        }
      }
    };
    dropMissingAndMisplaced();

    // A summary has one parent: the first of its own pointers, then its other
    // copies' (`parentId` before the older `mergedInto` in each, as readers
    // take them), that names a kept summary above it listing it among its
    // sources. A parent sits above its summary, so no two summaries can be
    // each other's parent. Without such a pointer, the parent is the kept
    // summary one level up that lists the summary, when exactly one does: a
    // pointer can name a summary further up, such as a grandparent, or
    // nothing, while the parent that covers the summary lists it, and
    // clearing the pointer would render the summary beside that parent.
    // `mergedInto`, which this strategy writes and its frontier reads, is set
    // to the parent, and so is a `parentId` naming anything else, so every
    // reader sees the one parent that renders the summary. With no parent,
    // every pointer that isn't null is cleared, so the summary renders and
    // merges again. A null pointer counts as none.
    //
    // A summary that lists one it isn't the parent of is dropped, and the
    // summaries naming it go with it, as for any dropped summary. A summary
    // above L1 covers the messages of each summary it lists, so a summary two
    // kept summaries list has its messages covered twice, and hierarchical
    // mode, which shows summaries that have no parent, renders both. Two
    // instances on one store each write a merge of the same run where neither
    // sees the other's pointers when it checks, as before merges read the
    // store's summaries, or where a merge stopped between its summary and its
    // pointers: the run's pointers name the merge written last, and the other
    // is dropped. Where a crash split the pointers between the two, each
    // lists a source whose parent is the other, so both are dropped. A
    // summary that two list and whose pointers name neither has no parent, so
    // both are dropped and it merges again. Each summary's parent is chosen
    // before any of these drops, so what is dropped doesn't depend on which
    // summary the pass reaches first. The cost: when the pass drops a
    // summary's chosen parent for listing another summary, the summary's
    // other listers go too, though one of them could have been its parent,
    // and the summary merges again.
    const reparentedIds: string[] = [];
    const clearedIds: string[] = [];
    const notParentIds: string[] = [];
    const covers = (pointer: unknown, summary: SummaryEntry): pointer is string => {
      const parent = typeof pointer === 'string' ? byId.get(pointer) : undefined;
      return !!parent && parent.level > summary.level && parent.sourceIds.includes(summary.id);
    };
    const listedBy = new Map<string, SummaryEntry[]>();
    for (const summary of byId.values()) {
      if (summary.level === 1) continue;
      for (const sourceId of new Set(summary.sourceIds)) {
        const listers = listedBy.get(sourceId);
        if (listers) listers.push(summary);
        else listedBy.set(sourceId, [summary]);
      }
    }
    const parentOf = new Map<string, string | undefined>();
    for (const summary of byId.values()) {
      const pointers = [summary, ...copiesById.get(summary.id)!]
        .flatMap((copy) => [copy.parentId, copy.mergedInto] as unknown[]);
      const listers = (listedBy.get(summary.id) ?? []).filter((lister) => lister.level === summary.level + 1);
      parentOf.set(summary.id, pointers.find((pointer): pointer is string => covers(pointer, summary)) ??
        (listers.length === 1 ? listers[0]!.id : undefined));
    }
    for (const [id, summary] of byId) {
      if (summary.level > 1 && summary.sourceIds.some((sourceId) => parentOf.get(sourceId) !== id)) {
        byId.delete(id);
        notParentIds.push(id);
        textDrops.set(id, { summary, reason: 'names-non-child' });
      }
    }
    dropMissingAndMisplaced();
    this.summaries = [...byId.values()].map((summary) => {
      // A parent chosen above is the one kept summary that still lists this
      // one; where the drops took it, nothing kept lists this one.
      const chosen = parentOf.get(summary.id);
      const parent = chosen !== undefined && byId.has(chosen) ? chosen : undefined;
      let repaired = summary;
      const edit = () => (repaired === summary ? (repaired = { ...summary }) : repaired);
      if (parent === undefined) {
        for (const field of ['parentId', 'mergedInto'] as const) {
          const own = summary[field] as unknown;
          if (own === undefined || own === null) continue;
          delete edit()[field];
        }
        if (repaired !== summary) clearedIds.push(summary.id);
        return repaired;
      }
      if (summary.mergedInto !== parent) edit().mergedInto = parent;
      const ownParentId = summary.parentId as unknown;
      if (ownParentId !== undefined && ownParentId !== null && ownParentId !== parent) edit().parentId = parent;
      if (repaired !== summary) reparentedIds.push(summary.id);
      return repaired;
    });
    const droppedIds = [...copiesById.keys()].filter((id) => !byId.has(id));
    const keptRebuiltIds = rebuiltIds.filter((id) => byId.has(id));
    if (malformed > 0 || dupes > 0 || droppedIds.length > 0 || keptRebuiltIds.length > 0 ||
        reparentedIds.length > 0 || clearedIds.length > 0) {
      // Read before the write, which moves the branch's sequence past the
      // summaries as they were. A repair that dropped only empty summaries,
      // or none, lost no text and has no report: its line below says it all.
      const report = textDrops.size > 0
        ? this.loadRepairReport(this.store, [...copiesById.keys()], textDrops, emptyIds.length)
        : undefined;
      this.store.setStateJson(this.summariesStateId, this.summaries);
      this.diag.warn(
        `[autobiographical] repaired summary state: removed ${malformed} malformed entr(ies) and deduped ${dupes}; ` +
          `dropped empty [${emptyIds.join(', ')}], with unreadable sources or range [${unreadableIds.join(', ')}], ` +
          `naming a missing summary [${ancestorIds.join(', ')}], naming one not below it [${misplacedIds.join(', ')}], ` +
          `naming one it isn't the parent of [${notParentIds.join(', ')}]; ` +
          `rebuilt sources or range of ` +
          `[${keptRebuiltIds.join(', ')}]; set the parent of [${reparentedIds.join(', ')}]; cleared ` +
          `the parent pointers of [${clearedIds.join(', ')}], which named no kept parent`,
      );
      if (report) this.deliverLoadRepair(report);
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
        this.diag.warn(
          `[autobiographical] repaired ${repairedChunkRecords} chunk record(s) with missing L1 summaries`,
        );
      }
    }

    const queue = this.store.getStateJson(this.mergeQueueStateId);
    this.mergeQueue = Array.isArray(queue)
      ? (queue as Array<{ level: SummaryLevel; sourceIds: string[]; attempts?: number; lastStopReason?: string; lastOutcome?: string; hadRefusal?: boolean }>)
      : [];
    const mergeQuarantine = this.store.getStateJson(this.mergeQuarantineStateId);
    const storedMergeRecords = Array.isArray(mergeQuarantine) ? (mergeQuarantine as MergeQuarantineRecord[]) : [];
    // A record's sources are a list of ids, each a non-empty string. The list
    // may be empty: at mergeThreshold 0 the threshold pass and the demand path
    // queue an empty group, and its refused record, standing, is what keeps
    // enqueueMerge() from queuing that group again (mergeRecordStands; #285,
    // whose fix decides what such a record means).
    const isSourceList = (ids: unknown): boolean => Array.isArray(ids) && (ids.length === 0 || isIdList(ids));
    const loadedMergeRecords = storedMergeRecords.filter((r) => r && typeof r.key === 'string' && isSourceList(r.sourceIds));
    this.mergeQuarantine = new Map(loadedMergeRecords.map((r) => [r.key, r]));
    // What the load can't read is named and written back without, as the merge
    // queue's load below names what it removes and writes its queue back.
    // Records are written from a merge group, by refuseCrossedMerge and
    // quarantineMerge, so an entry that fails this, or a stored value that
    // holds no list, is damage or another writer's. Left in the store, it
    // would go at whatever write of the map came next, the sweep's included,
    // and a store holding nothing else would name it at every load.
    const leftOutMergeRecords = storedMergeRecords.length - loadedMergeRecords.length;
    const unlistedMergeQuarantine = mergeQuarantine != null && !Array.isArray(mergeQuarantine);
    if (unlistedMergeQuarantine || leftOutMergeRecords > 0) {
      // Written first, as the repairs beside it are, so the line says what was done.
      this.persistMergeQuarantine();
      const at = `[merge-quarantine] on branch '${this.store.currentBranch().name}', ${this.mergeQuarantineStateId}`;
      const one = leftOutMergeRecords === 1;
      this.diag.warn(
        unlistedMergeQuarantine
          ? `${at} holds no list, so the load reads no record from it and writes an empty list in its place: whatever it held ` +
              'is lost'
          : `${at} holds ${leftOutMergeRecords} entr${one ? 'y' : 'ies'} the load can't read as ${one ? 'a record' : 'records'} ` +
              `(${one ? 'it needs' : 'each needs'} a string key, and sourceIds a list whose ids are all non-empty strings), ` +
              `so the load leaves ${one ? 'it' : 'them'} out and writes the quarantine back without ${one ? 'it' : 'them'}: any group ` +
              `${one ? 'it' : 'they'} held is no longer held out of merges or counted by the merge-quarantine alarm or ` +
              'getCompressionDebt()',
      );
    }
    // A queued merge is kept only while it is an entry whose sources are kept
    // summaries, as for a summary above L1.
    const validMergeQueue = this.mergeQueue.filter(
      merge => merge && isIdList(merge.sourceIds) && merge.sourceIds.every((sourceId) => byId.has(sourceId)),
    );
    if (validMergeQueue.length !== this.mergeQueue.length) {
      const removed = this.mergeQueue.length - validMergeQueue.length;
      this.mergeQueue = validMergeQueue;
      this.store.setStateJson(this.mergeQueueStateId, this.mergeQueue);
      this.diag.warn(`[autobiographical] removed ${removed} merge queue item(s) with missing or unreadable sources`);
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
    if (this.config.foldingStrategy === 'kv-unified') {
      if (!options.keepKvUnifiedPresentation) {
        const receiptState = this.store.getStateJson(this.kvUnifiedReceiptStateId);
        this.kvUnifiedReceipts = receiptState && typeof receiptState === 'object'
          ? KvUnifiedReceiptChain.deserialize(receiptState as unknown as SerializedReceiptChain)
          : new KvUnifiedReceiptChain();
        this.kvUnifiedDraft = null;
        this.kvUnifiedPendingLayout = null;
        this.kvUnifiedPendingMarkerUnitIndices = [];
        this.kvUnifiedPendingImmutablePrefixHash = null;
        this.kvUnifiedPendingRender = null;
      }
    } else {
      // A presentation receipt is kv-unified's record of the LAST accepted
      // presentation. Once another folding strategy PRESENTS from this store
      // the receipt no longer describes the previous turn, and a later switch
      // back would measure continuity against a days-old baseline and treat
      // everything folded since as extension (#97). Loading is not
      // presenting: an inspection tool that opens the store with a different
      // strategy, or a compile with `dryRun: true`, must leave the receipt
      // alone. Only note here that a receipt exists; the first non-dry-run
      // ADAPTIVE select by a non-kv-unified strategy (selectAdaptive, after
      // the resolutions commit) supersedes it. A caller that previews through
      // a non-dry-run compile is presenting as far as this class can tell,
      // and `adaptiveResolution: false` (selectHierarchical writes nothing by
      // design) never supersedes.
      this.kvUnifiedReceiptSupersedePending =
        this.store.listStates().some((state) => state.id === this.kvUnifiedReceiptStateId) &&
        this.store.getStateJson(this.kvUnifiedReceiptStateId) != null;
      this.kvUnifiedReceipts = new KvUnifiedReceiptChain();
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
    this.writeStateJson(this.resolutionsStateId, out);
  }

  /** This strategy has just presented, so the persisted kv-unified receipt no
   * longer describes the previous turn. Null it (the slot keeps its history in
   * the record log) so a later switch back to kv-unified starts from an empty
   * chain — one cold-cache turn, which the migration runbook already expects —
   * instead of measuring against a stale baseline and treating everything
   * folded since as extension (#97). */
  protected supersedeKvUnifiedReceipt(): void {
    if (!this.store) return;
    this.requireBranchMutation('supersedeKvUnifiedReceipt');
    this.store.setStateJson(this.kvUnifiedReceiptStateId, null);
    // Cleared only after the write: if it throws, a later compile retries.
    this.kvUnifiedReceiptSupersedePending = false;
    this.diag.warn(
      `[autobiographical] superseded a persisted kv-unified presentation receipt: ` +
        `${String(this.config.foldingStrategy ?? 'default')} has presented from this store; ` +
        `a later switch back to kv-unified starts from an empty receipt chain`,
    );
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
   * Pin a range of messages. A pin's bound is its `level`, or without one
   * its `maxLevel` (`normalizePinLevels`). A raw pin, with no bound or a
   * bound of 0, keeps the messages out of compression and renders them raw
   * at their original position. A compile whose budget can't hold them
   * beside the rest refuses with `OverBudgetError`; where the adaptive plan's
   * middle is over the budget, it names each pin keeping raw tokens in that
   * middle (`rawPinsDiagnostics`). Under adaptive resolution, a message
   * stored in parts counts as one: a pin whose first or last id names one of its parts
   * covers it from its first part to its last, less a part locked with
   * `lockChunk` outside the span its ids name, for every reader of pins
   * (`pinPositions`). A bound above 0 is read only under
   * `foldingStrategy: 'kv-stable'` and `'kv-unified'` with
   * `adaptiveResolution` (`readsPinBounds`): there the range is still
   * compressed, since only a summary can supply its level, and is held at
   * `level`, or no deeper than `maxLevel`, as `ProtectedRange` describes.
   * Anywhere else the range is raw. Where bounds are read and pins overlap at
   * a message, the bound `ProtectedRange` names holds it
   * (`resolvedPinBounds`), which can compress a message a raw pin covers.
   * Returns the pin id.
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
   * information the agent wants to keep. Functionally a single-message pin
   * with `kind: 'document'`, and `opts` reads as `pinRange`'s: without a
   * `level` or `maxLevel` the message is kept raw, while `{ maxLevel }` lets
   * it fold no deeper than that level where the selector reads level bounds.
   * Under adaptive resolution, a mark on any part of a message stored in
   * parts covers the whole message, as `pinRange` does (`pinPositions`).
   * Under `kv-stable`, a mark with `level` (not `maxLevel`) holds whole each
   * summary it reaches, so a locked part that shares a summary with a part
   * the mark covers renders at the level the mark holds that summary at.
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
   * V2 dynamic pin-at-level-k convenience: fix a range to render at fold
   * level `level` (0 = raw). Under kv-stable, a chunk whose summaries stop
   * below `level` renders at the deepest it has, and one whose own-lineage
   * summary at `level` doesn't list it renders where one does, or raw
   * (`ProtectedRange.level`). Honored by `foldingStrategy: 'kv-stable'`
   * and `'kv-unified'` with adaptive resolution (under kv-unified, a message
   * no summary supplies that level over yet is held at the deepest level
   * below it that one does; see `ProtectedRange.level`); under any other
   * selector the range is raw (`resolvedPinBounds`), in the live view and
   * in the canonical L1 compression prompt where its budgets allow (see
   * `compressionRecallBudgetTokens`).
   * Equivalent to `pinRange(first, last, { level })`.
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
   * List summaries whose source message span overlaps `[opts.fromMs, opts.toMs]`,
   * for a "browse my history" table-of-contents (agent-framework consumer) —
   * read-only, generates nothing.
   *
   * Deliberately channel-agnostic: `SummaryEntry` has no channel field — a
   * summary is a fold over whatever messages landed in a chunk, which can span
   * several channels. A caller that wants a per-channel breakdown should use
   * the resolved `[startMs, endMs]` span against the message store's own
   * channel/time index (e.g. `getChannelTokenStats`) — NOT the returned
   * `sourceIds`: that field is message IDs only at L1, but is itself a list
   * of CHILD SUMMARY IDs at L2+ (see `SummaryEntry.sourceIds`'s own doc), so
   * it can't be used uniformly across levels the way the time span can.
   *
   * Linear scan over `this.summaries` — fine here (unlike raw-message
   * queries): even a very large resident mints a few thousand summaries over
   * its lifetime, and the whole array is already resident in memory.
   *
   * Can throw via `requireLoadedBranch` if called against a stale branch
   * generation — same as every other method on this strategy; the
   * `ContextManager.getSummariesInRange`/`getMaxSummaryLevel` passthroughs do
   * NOT swallow that, only the "wrong strategy type" case returns `[]`/`0`.
   */
  listSummariesInRange(
    store: MessageStoreView,
    opts: { fromMs?: number; toMs?: number; level?: number },
  ): TimeRangeSummaryEntry[] {
    this.requireLoadedBranch('listSummariesInRange');
    const fromMs = opts.fromMs ?? -Infinity;
    const toMs = opts.toMs ?? Infinity;

    const out: TimeRangeSummaryEntry[] = [];
    for (const entry of this.summaries) {
      if (opts.level !== undefined && entry.level !== opts.level) continue;

      // Resolve the source span to wall-clock time via the message store.
      // A source message can in principle be gone (redacted) by the time
      // this runs; skip rather than throw so one stale entry doesn't blank
      // the whole table-of-contents.
      const firstMsg = store.get(entry.sourceRange.first);
      const lastMsg = store.get(entry.sourceRange.last);
      if (!firstMsg || !lastMsg) continue;
      const startMs = firstMsg.timestamp.getTime();
      const endMs = lastMsg.timestamp.getTime();

      // Standard interval overlap test against the (possibly open) query range.
      if (!(startMs <= toMs && endMs >= fromMs)) continue;

      out.push({
        id: entry.id,
        level: entry.level,
        content: entry.content,
        tokens: entry.tokens,
        startMs,
        endMs,
        firstMessageId: firstMsg.id,
        lastMessageId: lastMsg.id,
        firstSequence: firstMsg.sequence,
        lastSequence: lastMsg.sequence,
        createdMs: entry.created,
        sourceIds: entry.sourceIds,
        parentId: getSummaryParentId(entry),
      });
    }

    out.sort((a, b) => a.startMs - b.startMs);
    return out;
  }

  /**
   * Cheap upper bound on the fold pyramid's depth: `max(level)` over every
   * currently-minted summary. 0 when no summaries exist yet. Lets a caller
   * (e.g. the browse-history tool) decide which levels are worth querying
   * without first calling `listSummariesInRange` and inspecting the result.
   */
  getMaxSummaryLevel(): number {
    this.requireLoadedBranch('getMaxSummaryLevel');
    // Avoid Math.max(...array): spreading onto the call stack overflows well
    // before real-world summary counts get anywhere close (review finding,
    // 2026-09) — a plain reduce has the same O(n) cost with no such cliff.
    return this.summaries.reduce((max, s) => Math.max(max, s.level), 0);
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
   * The store positions a pin covers, in order. Without adaptive resolution,
   * the messages from its first id to its last. Under adaptive resolution,
   * the only ingress that stores a message in parts, such a message counts as
   * one: the span runs from the first part of the message its first id is in
   * to the last part of the message its last id is in (`bodyBoundsIn`), less
   * a part locked with `lockChunk` outside the span its ids name. A lock is
   * said of that part, while covering the rest of its message is what a pin
   * on another part implies, so the lock holds there; a pin over its own
   * locked messages keeps the rule `lockChunk` describes. Every reader of
   * pins takes this: the selects, compression, the summarizer's prompt and
   * the replay exporter. Undefined when either id is no longer in the store.
   */
  protected pinPositions(
    pin: ProtectedRange,
    positionOf: ReadonlyMap<MessageId, number>,
    messages: readonly StoredMessage[],
  ): number[] | undefined {
    const first = positionOf.get(pin.firstMessageId);
    const last = positionOf.get(pin.lastMessageId);
    if (first === undefined || last === undefined) return undefined;
    const lo = Math.min(first, last);
    const hi = Math.max(first, last);
    const whole = this.config.adaptiveResolution === true;
    const from = whole ? bodyBoundsIn(messages, lo).from : lo;
    const to = whole ? bodyBoundsIn(messages, hi).to : hi;
    const out: number[] = [];
    for (let i = from; i <= to; i++) {
      if ((i < lo || i > hi) && this.locked.has(messages[i].id)) continue;
      out.push(i);
    }
    return out;
  }

  /**
   * Build a set of message-store positions covered by any pin
   * (`pinPositions`). O(N pins · K range). Returns positions for which the
   * message exists; orphan pins (deleted messages) are silently skipped.
   */
  protected pinnedPositions(messages: StoredMessage[]): Set<number> {
    if (this.pins.length === 0) return new Set();
    const positionOf = this.positionIndex(messages);
    const out = new Set<number>();
    for (const pin of this.pins) {
      for (const i of this.pinPositions(pin, positionOf, messages) ?? []) out.add(i);
    }
    return out;
  }

  /**
   * The fold bound each pinned message position resolves to, decided once
   * for compression and every selector: raw, a fixed level, or a depth cap.
   * Bounds (`ProtectedRange.level` / `maxLevel`) are honored only by the
   * folding strategies that read them, `kv-stable` and `kv-unified`. Under
   * every other selector, and without adaptive resolution, a pinned position
   * is raw, as `pinAtLevel` documents. Where pins overlap at one position,
   * kv-stable's reading applies: a bound there takes the place of a classic
   * pin, a fixed level takes the place of a cap, and within each kind the
   * lowest wins (`pinLevelBounds`). A level or cap of 0 is raw
   * (`isRawPinBound`).
   */
  protected resolvedPinBounds(messages: StoredMessage[]): Map<number, ResolvedPinBound> {
    const out = new Map<number, ResolvedPinBound>();
    const pinned = this.pinnedPositions(messages);
    if (pinned.size === 0) return out;
    const bounds = this.readsPinBounds() ? this.pinLevelBounds(messages) : undefined;
    for (const position of pinned) {
      const bound = bounds?.get(position);
      if (bound?.level !== undefined) out.set(position, { level: bound.level });
      else if (bound?.maxLevel !== undefined) out.set(position, { maxLevel: bound.maxLevel });
      else out.set(position, 'raw');
    }
    return out;
  }

  /** Whether this selector reads pin bounds (`ProtectedRange.level` /
   *  `maxLevel`): `kv-stable` and `kv-unified`, with adaptive resolution. */
  protected readsPinBounds(): boolean {
    return !!this.config.adaptiveResolution &&
      (this.config.foldingStrategy === 'kv-stable' || this.config.foldingStrategy === 'kv-unified');
  }

  /** Whether a resolved pin bound keeps its message raw: a classic pin, or a
   *  level or cap of 0. */
  static isRawPinBound(bound: ResolvedPinBound): boolean {
    if (bound === 'raw') return true;
    return 'level' in bound ? bound.level === 0 : bound.maxLevel === 0;
  }

  /** Positions of the messages that pins keep raw (`resolvedPinBounds`). */
  protected forceRawPinPositions(messages: StoredMessage[]): Set<number> {
    const out = new Set<number>();
    for (const [position, bound] of this.resolvedPinBounds(messages)) {
      if (AutobiographicalStrategy.isRawPinBound(bound)) out.add(position);
    }
    return out;
  }

  /**
   * The V2 dynamic-pin fold-depth bounds (`ProtectedRange.level` /
   * `maxLevel`) by message position. Only pins that carry a bound appear; a
   * classic raw pin (no bound) is absent here and handled by `pinnedPositions`.
   * A pin covers what `pinPositions` says. Where bounded pins overlap, the
   * lowest fixed level and the lowest cap are kept; `resolvedPinBounds`
   * decides between them and a classic pin.
   */
  protected pinLevelBounds(messages: StoredMessage[]): Map<number, { level?: number; maxLevel?: number }> {
    const out = new Map<number, { level?: number; maxLevel?: number }>();
    if (this.pins.length === 0) return out;
    const positionOf = this.positionIndex(messages);

    for (const pin of this.pins) {
      if (pin.level === undefined && pin.maxLevel === undefined) continue;
      for (const i of this.pinPositions(pin, positionOf, messages) ?? []) {
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

  /** Sliding-window timestamps of split-stitch sub-calls (compressionSplitMaxCallsPer10Min). */
  protected splitCallTimes: number[] = [];
  /** This instance's split call window, as its waits name it (CompressionSplitWindowWait). */
  private readonly splitWindow = Symbol('split call window');
  /** Accounting of the most recent split-stitch attempt (receipts/tests). */
  /** Aggregate details of the most recent stitched response (receipts/tests). */
  protected lastSplitDetails: NormalizedResponse['details'] | undefined;
  protected lastSplitAttempted: { calls: number; refused: number; errors: number; inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number; complete: boolean } | undefined;

  /**
   * Append a summary to the in-memory list and to the chronicle AppendLog.
   * Single point so subclasses inherit persistence. A summary readers can't
   * use is refused with an error, and nothing is held or stored: empty text,
   * `sourceIds` that aren't a non-empty list of ids, or above L1 a
   * `sourceRange` that isn't two message ids. An L1 is stored with its range
   * set to its sources' first and last ids, with a warning when it held
   * another.
   */
  protected pushSummary(entry: SummaryEntry): void {
    this.requireBranchMutation('pushSummary');
    if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
      throw new Error(
        `[autobiographical] refusing to persist empty summary ${entry.id} at L${entry.level}`,
      );
    }
    // Sources readers can't use, and above L1 a range they can't use, are
    // refused here, where the code that built the summary is still on the
    // stack. Persisted, it reaches readers that can't use it until an open
    // rebuilds or drops it, and by then nothing says where it came from: the
    // null `sourceIds` that #130 found in a real store has no known writer.
    const unreadable = unreadableSourcesOrRange(entry);
    if (unreadable) {
      throw new Error(
        `[autobiographical] refusing to persist summary ${entry.id} at L${entry.level}, a bug in the code ` +
          `that built it: ${unreadable}`,
      );
    }
    // The open rewrites any other range an L1 holds to its sources' ends, so
    // the write stores that range now, and says what the summary held.
    const ids = entry.sourceIds;
    const range = entry.sourceRange as { first?: unknown; last?: unknown } | null | undefined;
    if (entry.level === 1 && (range?.first !== ids[0] || range?.last !== ids[ids.length - 1])) {
      this.diag.warn(
        `[autobiographical] storing summary ${entry.id} at L1 with its sourceRange set to its first and last ` +
          `source, a bug in the code that built it: it held ${JSON.stringify(range)}`,
      );
      entry.sourceRange = { first: ids[0]!, last: ids[ids.length - 1]! };
    }
    this.summaries.push(entry);
    this.store?.appendToStateJson(this.summariesStateId, entry);
  }

  /**
   * The L1 written for a chunk, by its joined source ids. Another instance
   * sharing the store may have written it since this one loaded, perhaps
   * with summaries above it that this one doesn't hold, so a miss here reads
   * the store too. When the store has it, this instance reloads the store's
   * summaries, as a compression that waited on another instance's does,
   * keeping its kv-unified presentation in flight (#166). The L1 then comes
   * with the summaries above it, repaired as the loader repairs them. The
   * open's other steps, such as chunk-record migration, the chunk rebuild,
   * the merge queue's sanitizing and the topology audit, don't run here.
   * Adopting the L1 alone left its parent pointer naming a summary this
   * instance didn't hold, which kv-unified's canonical forest refuses on
   * every compile.
   */
  private findExactL1(chunkIdKey: string): SummaryEntry | undefined {
    const held = this.heldExactL1(chunkIdKey);
    if (held) return held;
    const persisted = this.store?.getStateJson(this.summariesStateId);
    if (!Array.isArray(persisted)) return undefined;
    const written = (persisted as Array<SummaryEntry | null>).some(
      (summary) => summary?.level === 1 && isIdList(summary.sourceIds) && summary.sourceIds.join(':') === chunkIdKey,
    );
    if (!written) return undefined;
    this.takeUpStoreState();
    return this.heldExactL1(chunkIdKey);
  }

  /** First held L1 per joined source-id key, rebuilt only when the summary
   *  list's entries change (the scan joined every L1's ids on every call). */
  private _exactL1: { entries: readonly SummaryEntry[]; byKey: Map<string, SummaryEntry> } | null = null;
  private heldExactL1(chunkIdKey: string): SummaryEntry | undefined {
    const memo = this._exactL1;
    const current = this.summaries;
    let byKey: Map<string, SummaryEntry>;
    if (memo && memo.entries.length === current.length && memo.entries.every((s, i) => s === current[i])) {
      byKey = memo.byKey;
    } else {
      byKey = new Map();
      for (const summary of current) {
        if (summary.level !== 1) continue;
        const key = summary.sourceIds.join(':');
        if (!byKey.has(key)) byKey.set(key, summary);
      }
      this._exactL1 = { entries: [...current], byKey };
    }
    return byKey.get(chunkIdKey);
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
   * <id>." question turn that wraps each recall body, and the resume turn
   * after it where the agent's own turn follows (RECALL_RESUME_TEXT). Rough
   * but defensive.
   *
   * Under `recallEnvelope: 'xml'` the answer body also carries the envelope
   * tags, so the estimate prices that summary's ACTUAL envelope string on top
   * — attributes included, and zero when the envelope is off. A second magic
   * constant would drift from the tag the moment either changed.
   */
  protected capRecallPairs(
    summariesChronological: SummaryEntry[],
    maxTokens: number,
  ): { kept: SummaryEntry[]; keptTokens: number } {
    const kept: SummaryEntry[] = [];
    let total = 0;
    for (let i = summariesChronological.length - 1; i >= 0; i--) {
      const s = summariesChronological[i]!;
      const envelopeText = recallEnvelopeAddedText(s, this.config.recallEnvelope);
      const est = (s.tokens ?? Math.ceil(s.content.length / 4)) + 50 +
        this.estimateTokens([{ type: 'text', text: envelopeText }]);
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
   * with zero `cache_control` and was re-read cold on every call. They share
   * the head window only while they summarize one topic's history: after a
   * head-window reset, requests for different topics' history each carry
   * that topic's head (headAsOf). Markers
   * land at the three boundaries whose survival probability ranks highest
   * (measured optimum; `analysis/2026-08-20-cm37-cache-partition-experiments.md`
   * in the workspace root):
   *
   *   1. end of head window        — survives everything short of identity edits,
   *                                  among requests for one topic's history
   *   2. last level>=2 recall pair — survives appends AND L1→L2 merges (a
   *      merge replaces the run at this boundary and extends it)
   *   3. last recall pair          — the append frontier
   *
   * Only pairs whose id is in `recallLadder` (the kept prior-summary list)
   * count as prefix: a merge's expanded SOURCE pairs are its volatile
   * payload, and marking them would cache-write content that never recurs.
   *
   * `capped` requests get the head marker only: recall-budget front-eviction
   * shifts the pairs on every subsequent mint, and cache writes on a shifting
   * prefix are pure waste (measured up to +42% total cost at 1h TTL). The
   * head boundary sits before the ladder, so eviction cannot move it; with
   * no head window a capped request carries no marker at all.
   * Effective ladder reuse also requires the append-stable source order
   * fix (2026-08-19); on stores minted under the older lexical order the
   * markers are merely harmless.
   *
   * Returns true iff at least one breakpoint was placed — callers attach
   * `cacheTtl` only then, so every marker-less request (kill switch, capped
   * ladder with no head window, no ladder yet) keeps the exact pre-seam request shape and its
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
    const levelById = new Map(recallLadder.map((s) => [s.id, s.level]));
    let headEnd = -1;
    let deepEnd = -1;
    let frontierEnd = -1;
    for (let i = 0; i < messages.length - 1; i++) {
      const id = recallHeaderId(messages[i]!);
      if (id === undefined) continue;
      const level = levelById.get(id);
      if (level === undefined) continue;
      if (frontierEnd === -1 && i > 0) headEnd = i - 1;
      frontierEnd = i + 1;
      if (level >= 2) deepEnd = i + 1;
    }
    if (frontierEnd === -1) return false; // no ladder yet — nothing stable to cache
    // A capped ladder front-evicts on every mint, so the pair seams shift and
    // writing them is waste. The head seam does not: tools, system prompt and
    // head window precede the ladder and are the same request after request
    // for one topic's history (headAsOf gives each topic its own head),
    // unless image shedding (one byte budget, spent newest-first) replaces a
    // head image for one payload and not for the next.
    let placed = false;
    for (const idx of new Set(capped ? [headEnd] : [headEnd, deepEnd, frontierEnd])) {
      if (idx < 0) continue;
      messages[idx]!.cacheBreakpoint = true;
      placed = true;
    }
    return placed;
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

  /**
   * A request's complete bound with each block priced as its route sends it
   * (sentForm). Where a route sends more of a block than that, what the
   * rung adds is priced low by the difference. Two such places are known:
   *   - a redacted_thinking block carrying a reasoning item, on Anthropic,
   *     which sends it whole: met only where a compression model moved from
   *     a Responses route to Anthropic replays its earlier answers, and
   *     whether Anthropic accepts such a block at all is unchecked;
   *   - a block whose rawItem outweighs its fields, on the Responses API
   *     route, which sends the item: the item's own overhead, such as its id
   *     and status, unmeasured.
   */
  private sentBoundTokens(request: NormalizedRequest): number {
    return this.compressionRequestInputBoundTokens({
      ...request,
      messages: request.messages.map((m) => ({ ...m, content: m.content.map(sentForm) })),
    });
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
    const typed = response as { usage?: unknown; details?: { usage?: unknown } };
    const detailed = typed.details?.usage;
    const usage = detailed && typeof detailed === 'object' ? detailed : typed.usage;
    if (!usage || typeof usage !== 'object') return undefined;
    const read = (key: 'inputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'): number | undefined => {
      const value = (usage as Record<string, unknown>)[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    // membrane 0.6.0 and later states usage with uncached input, cache writes
    // and cache reads as disjoint counts wherever it knows the convention,
    // Gemini's included, so the prompt's total is their sum whatever the
    // provider, and a full cache hit is a zero input count beside a positive
    // cache read. The usage comes from the host's instance (ctx.membrane),
    // which this package's range doesn't bind: a host on an older membrane
    // passes Gemini's counts raw, and before 0.5.81 OpenAI's too, with the
    // cached span inside the input count, so the sum counts that span twice
    // and admission is stricter. A usage whose convention membrane can't
    // establish keeps the counts its provider gives: in 0.6.0 that's
    // openai-compatible's and openai-completions', which never report cache
    // reads, and an OpenRouter response with no cache field, so the sum is
    // its input count.
    const input = read('inputTokens');
    // Usage without an input count, or with a zero total, is no observation
    // of the prompt: the complete normalized request bound stands instead.
    // Through complete(), which compression calls, membrane's Anthropic and
    // Bedrock adapters pass the provider's input count through, so a missing
    // one arrives as missing, as from a caller outside membrane. Its other
    // adapters report an omitted count as zero, so a zero beside cache counts
    // reads as a full cache hit: a response can't tell a provider's omitted
    // count from one, and membrane flags an omitted count only in a streamed
    // round's report (unreportedUsage).
    if (input === undefined) return undefined;
    const total = input + (read('cacheCreationTokens') ?? 0) + (read('cacheReadTokens') ?? 0);
    return total > 0 ? total : undefined;
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
      // One by one: a large child's leaves overflow a spread's argument limit.
      for (const id of childLeaves) leaves.push(id);
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
        // Logged only if it's dispatched; see prepareCompressionAhead.
        const preparedRequest = this.prepareCompressionAhead(request);
        variants.push({
          parent,
          children,
          leafCoverageHash,
          request: preparedRequest,
          requestHash: sha256Json(preparedRequest),
          deterministicInputBoundTokens: this.compressionRequestInputBoundTokens(preparedRequest),
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
   * Admission for a request the refusal ladder sends after the canonical, one
   * rule for the recall-curve variants and both tool-prose hoists: the
   * provider's count of the request it rewrites (its base), plus what the
   * rewrite adds in the complete normalized bound, plus the output reserve,
   * against compressionContextBudgetTokens. Each base is a request the
   * provider answered: the canonical, for the variants after a refusal or
   * an incomplete answer and for the canonical's hoist after a refusal, and
   * source-only-final, for its own hoist after a refusal. Its count is the
   * one this ladder took, or one the family's progress kept from an earlier
   * ladder: another strategy's on the same store, or one before a restart.
   * Where the base has no count, or the provider counted only its
   * carrier-stripped copy, the rewrite is admitted on its own complete
   * bound. Source-only-final and the split parts
   * aren't admitted: they send the canonical's chunk, whole
   * (source-only-final sends the canonical's own messages from the chunk
   * on) or in parts, without the recall pairs, and the provider has taken
   * the canonical, which sends all of it.
   * Admission prices what a rung adds to the request it rewrites, by that
   * request's count, and the rung's own bound where there's none. What a
   * rung adds is read from both requests with each block priced as the most
   * its route sends of it (sentBoundTokens). The complete bound counts a
   * block's raw replay forms beside its fields, and an edit releases them,
   * so the complete bounds' difference credited a released rawXml, which the
   * native formatter never sends, against what the rewrite adds (a hoist's
   * fell to -137 where what it sends grew by 592).
   */
  private compressionAdmission(
    base: NormalizedRequest,
    rewrite: NormalizedRequest,
    rewriteBoundTokens: number,
    baseProviderInputTokens: number | undefined,
  ): CompressionAdmission {
    const budgetTokens = this.normalizedCompressionContextBudget();
    const maxTokens = rewrite.config.maxTokens;
    // When the provider reports the base's input, it is authoritative and
    // must dominate admission even if our serialization happens to be
    // smaller. The positive delta keeps a nominally smaller or identical
    // serialization from treating an expansion as free.
    const expansionDeltaTokens = Math.max(1, this.sentBoundTokens(rewrite) - this.sentBoundTokens(base));
    // Once the provider has counted the base, that observed token total is
    // the baseline. The complete normalized UTF-8 bound remains the
    // fail-closed fallback when usage is absent, but must not override real
    // token accounting: large invariant tool schemas can be megabytes of JSON
    // while occupying a much smaller token window. The positive byte delta is
    // meant to be conservative for what the rewrite changed, short of the two
    // gaps sentBoundTokens names; what it left unchanged was accepted and
    // counted with the base. Each message adds 128
    // to the bound (compressionRequestInputBoundTokens), so a rewrite that adds
    // messages, as a hoist adds two for each argument it moves, pays for them
    // before its bytes, and near the budget it can be skipped where it would
    // have fit.
    const boundedInputTokens = baseProviderInputTokens === undefined
      ? rewriteBoundTokens
      : baseProviderInputTokens + expansionDeltaTokens;
    const outputReserveTokens = Math.max(0, Math.ceil(maxTokens));
    const admittedTokens = boundedInputTokens + outputReserveTokens;
    return {
      expansionDeltaTokens,
      boundedInputTokens,
      outputReserveTokens,
      admittedTokens,
      budgetTokens,
      disposition: admittedTokens > budgetTokens ? 'admission_rejected' : 'provider_attempt',
    };
  }

  /**
   * Freeze the exact fallback/admission plan. Before canonical inference this
   * supplies a deterministic family identity; after a refusal it is rebuilt
   * with authoritative canonical provider usage. When complete provider usage
   * is absent or not authoritative, as a count of the canonical's
   * carrier-stripped copy isn't, admission retains the conservative complete
   * normalized-request bound; otherwise the unchanged canonical request is
   * already represented by provider usage and only positive expansion is added
   * (compressionAdmission).
   */
  private compressionRefusalPlan(
    canonicalRequest: NormalizedRequest,
    variants: RecallCurveVariant[],
    canonicalProviderInputTokens?: number,
  ): CompressionRefusalPlanRecord[] {
    const fallbackLimit = this.normalizedCompressionFallbackLimit();
    if (fallbackLimit === 0) return [];
    const canonicalRequestBoundTokens = this.compressionRequestInputBoundTokens(canonicalRequest);
    const accountingSource = canonicalProviderInputTokens !== undefined
      ? 'canonical_provider_usage_plus_expansion' as const
      : 'complete_normalized_request_bound' as const;
    const plan: CompressionRefusalPlanRecord[] = [];
    let providerAttempts = 0;
    for (const variant of variants) {
      if (providerAttempts >= fallbackLimit) break;
      // A recall-curve variant is an expansion of the canonical prompt.
      const admission = this.compressionAdmission(
        canonicalRequest,
        variant.request,
        variant.deterministicInputBoundTokens,
        canonicalProviderInputTokens,
      );
      // The record's fields in their stored order: the quarantine key hashes
      // the plan as serialized.
      plan.push({
        curveLabel: `expand:${variant.parent.id}`,
        parentId: variant.parent.id,
        childIds: variant.children.map((child) => child.id),
        requestHash: variant.requestHash,
        accountingSource,
        canonicalRequestBoundTokens,
        deterministicInputBoundTokens: variant.deterministicInputBoundTokens,
        expansionDeltaTokens: admission.expansionDeltaTokens,
        boundedInputTokens: admission.boundedInputTokens,
        outputReserveTokens: admission.outputReserveTokens,
        admittedTokens: admission.admittedTokens,
        budgetTokens: admission.budgetTokens,
        disposition: admission.disposition,
      });
      if (admission.disposition === 'provider_attempt') providerAttempts++;
    }
    return plan;
  }

  /**
   * The active quarantine, replayed from the ledger (and the legacy snapshot
   * before it). An entry is made only from a usable record
   * (isUsableQuarantineRecord) and a usable generation (isUsableGenerationId),
   * whichever event or snapshot carries them, and an exhaustion's record must
   * carry the exhaustion's own key, which clears, alerts and checkpoints go
   * by. An entry left out that way is no longer in the quarantine, so it no
   * longer holds its chunk back: a chunk no other entry holds is tried again.
   * The key of each ledger entry left out for that reason, and not in the
   * quarantine through another event, goes into `dropped`, for the caller to
   * name. A checkpoint, known by its kind, replaces what came before it with
   * its list. One that holds no list holds no entry, so it replaces what came
   * before it with nothing, and it goes into `unlisted` by its index in the
   * ledger. Reading past it instead would bring back the legacy snapshot's
   * records whose clears the checkpoint writer's redaction removed. The
   * legacy snapshot is only read: the code that wrote it, replaced by the
   * ledger the day it arrived, gave every record its chunk hash, so a record
   * there without one is skipped as a keyless one always was.
   */
  private projectCompressionQuarantineEvents(
    events: CompressionQuarantineEvent[],
    legacyRecords: CompressionRefusalQuarantineRecord[] = [],
    dropped?: Set<string>,
    unlisted?: Set<string>,
  ): Map<string, ActiveCompressionQuarantine> {
    const active = new Map<string, ActiveCompressionQuarantine>();
    const legacyClaims = new Map<string, ActiveCompressionQuarantine>();
    for (const record of legacyRecords) {
      if (!isUsableQuarantineRecord(record)) continue;
      active.set(record.key, {
        generationId: `legacy:${record.key}`,
        record,
        outcomes: [],
        // The legacy implementation emitted its alert immediately after the
        // snapshot write. Treat it as accounted to avoid surprise replay.
        sentAlertKeys: new Set([record.key]),
      });
    }
    for (const [index, event] of events.entries()) {
      if (!event) continue;
      // A checkpoint is known by its kind; its key isn't read.
      if (event.kind === 'checkpoint') {
        active.clear();
        if (!Array.isArray(event.active)) {
          unlisted?.add(`the ledger's checkpoint at index ${index}`);
          continue;
        }
        for (const item of event.active) {
          if (!isUsableGenerationId(item?.generationId) || !isUsableQuarantineRecord(item.record)) {
            const key = (item as { record?: { key?: unknown } | null } | null | undefined)?.record?.key;
            if (typeof key === 'string') dropped?.add(key);
            continue;
          }
          active.set(item.record.key, {
            generationId: item.generationId,
            record: item.record,
            outcomes: outcomeList(item.outcomes),
            ...(item.pendingAlert ? { pendingAlert: item.pendingAlert } : {}),
            sentAlertKeys: new Set(Array.isArray(item.sentAlertKeys) ? item.sentAlertKeys : []),
          });
        }
        continue;
      }
      if (typeof event.key !== 'string') continue;
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
        // An exhaustion carries its record, or (in the format before the
        // record moved onto it) targets the claim that does.
        const own = Boolean(event.record);
        const record = own
          ? event.record
          : event.targetClaimId ? legacyClaims.get(event.targetClaimId)?.record : undefined;
        const generationId = own ? event.eventId : event.targetClaimId;
        if (!isUsableQuarantineRecord(record) || record.key !== event.key || !isUsableGenerationId(generationId)) {
          dropped?.add(event.key);
          continue;
        }
        active.set(event.key, {
          generationId,
          record,
          outcomes: outcomeList(event.outcomes),
          sentAlertKeys: new Set<string>(),
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
    // A key a damaged event named can stand in the quarantine through an
    // earlier or later usable one; only keys left out of it are named.
    if (dropped) for (const key of dropped) if (active.has(key)) dropped.delete(key);
    return active;
  }

  /**
   * The quarantine, read from the store. A ledger or legacy snapshot whose
   * value isn't a list holds no entry the strategy can use, so it's read as
   * holding nothing, as a ledger that isn't a list always was, and named
   * (reportUnlistedQuarantineState). A ledger like that has lost the clears
   * it held too, so the legacy snapshot it superseded isn't read beside it,
   * as a checkpoint that holds no list replaces what came before it with
   * nothing (projectCompressionQuarantineEvents): its cleared records would
   * come back. A stored null reads as no value at all.
   */
  private readCompressionQuarantineProjection(): Map<string, ActiveCompressionQuarantine> {
    if (!this.store) return new Map();
    const ledger = this.store.getStateJson(this.compressionRefusalQuarantineLedgerStateId);
    const legacy = this.store.getStateJson(this.compressionRefusalQuarantineStateId);
    const dropped = new Set<string>();
    const unlisted = new Set<string>();
    const ledgerHoldsNoList = ledger != null && !Array.isArray(ledger);
    if (ledgerHoldsNoList) unlisted.add('the ledger');
    if (legacy != null && !Array.isArray(legacy)) unlisted.add('the legacy snapshot');
    const active = this.projectCompressionQuarantineEvents(
      Array.isArray(ledger) ? ledger as CompressionQuarantineEvent[] : [],
      !ledgerHoldsNoList && Array.isArray(legacy) ? legacy as CompressionRefusalQuarantineRecord[] : [],
      dropped,
      unlisted,
    );
    if (dropped.size > 0) this.reportDroppedQuarantineEntries(dropped);
    if (unlisted.size > 0) this.reportUnlistedQuarantineState(unlisted);
    return active;
  }

  /** What of the quarantine's stored state a line has named as holding no list, so each is named once per load (initialize clears it). */
  private namedUnlistedQuarantineState = new Set<string>();

  /**
   * Name each stored quarantine value, or checkpoint in the ledger, that
   * holds no list, once per load: it's read as holding nothing, so the
   * quarantine has lost whatever it held.
   */
  private reportUnlistedQuarantineState(what: Set<string>): void {
    const fresh = [...what].filter((name) => !this.namedUnlistedQuarantineState.has(name));
    if (fresh.length === 0) return;
    for (const name of fresh) this.namedUnlistedQuarantineState.add(name);
    const one = fresh.length === 1;
    this.diag.warn(
      `[compression-quarantine] on branch '${this.store?.currentBranch().name ?? ''}', ${fresh.join(' and ')} ` +
        `${one ? 'holds' : 'hold'} no list, so the quarantine reads no entry from ${one ? 'it' : 'them'} ` +
        `and has lost whatever ${one ? 'it' : 'they'} held`,
    );
  }

  /** Keys of ledger entries the projection left out that a line has named, so each is named once per load (initialize clears it). */
  private namedDroppedQuarantineKeys = new Set<string>();

  /**
   * Name the ledger entries the projection left out for want of a usable
   * record or generation, each once per load. Such an entry is no longer in
   * the quarantine, so it no longer holds its chunk back, and a chunk no
   * other entry holds (durableQuarantineFor) is tried again. No clear
   * reaches it, since a clear takes only what's in the quarantine; it stays
   * in the ledger, read past, until a checkpoint
   * (checkpointCompressionQuarantineIfNeeded, once the ledger holds
   * COMPRESSION_QUARANTINE_CHECKPOINT_EVENTS events) rewrites the ledger
   * without it.
   */
  private reportDroppedQuarantineEntries(keys: Set<string>): void {
    const fresh = [...keys].filter((key) => !this.namedDroppedQuarantineKeys.has(key));
    if (fresh.length === 0) return;
    for (const key of fresh) this.namedDroppedQuarantineKeys.add(key);
    const one = fresh.length === 1;
    this.diag.warn(
      `[compression-quarantine] on branch '${this.store?.currentBranch().name ?? ''}', left out ledger ${one ? 'entry' : 'entries'} it can't use ` +
        `(keys=${fresh.map((key) => key.slice(0, 12)).join(',')}): ${one ? 'it no longer holds its chunk' : 'they no longer hold their chunks'} back, ` +
        `no clear reaches ${one ? 'it' : 'them'}, and ${one ? 'it stays' : 'they stay'} in the ledger until a checkpoint ` +
        `rewrites the ledger, which needs ${COMPRESSION_QUARANTINE_CHECKPOINT_EVENTS} events in it`,
    );
  }

  /**
   * The durable quarantine in `projection` that stops `record`'s request,
   * if any. The gate skips a chunk on it, and a joined call reads it again
   * once the call it joined is in, so both say the same of a request.
   */
  private durableQuarantineFor(
    projection: Map<string, ActiveCompressionQuarantine>,
    record: CompressionRefusalQuarantineRecord,
  ): ActiveCompressionQuarantine | undefined {
    // Bounded by chunk hash, not just request identity (2026-08-06
    // ear-loop): as sibling chunks mint, the recall frontier shifts, so
    // every maintenance pass built a NEW key/familyKey for the same
    // refusing span — each cycle burned a full refused call and minted a
    // duplicate quarantine record, forever. A GENUINE shape change
    // (carriers arrive, tools arrive, config change) deserves a fresh
    // attempt — that self-healing is deliberate and pinned by tests — so
    // the gate is a CAP, not a wall: up to CHUNK_QUARANTINE_SHAPE_CAP
    // distinct quarantined shapes per chunk and request regime, then sticky
    // until success-clear or the paid-off sweep, which match by chunkSourceHash
    // and so clear every shape of the span, or an operator's clear: of every
    // record, or of one by its key, which leaves the span's other shapes
    // counting toward the cap. A shape whose ledger entry is found unusable
    // is left out of the projection, and so stops counting too.
    const sameHash = [...projection.values()].filter(
      (active) => active.record.chunkSourceHash === record.chunkSourceHash &&
        active.record.normalizedConfig?.accountingVersion === COMPRESSION_BUDGET_ACCOUNTING_VERSION,
    );
    // The shape cap is per request regime, not merely per source chunk. Enabling
    // the final source-only rung is a genuine request-family change and must
    // earn a fresh bounded family even when the old regime already filled its
    // cap. Within the new regime the cap remains sticky.
    const sameRegime = sameHash.filter((active) =>
      active.record.normalizedConfig?.sourceOnlyFallbackEnabled ===
        record.normalizedConfig.sourceOnlyFallbackEnabled &&
      active.record.normalizedConfig?.sourceOnlyFallbackRequestHash ===
        record.normalizedConfig.sourceOnlyFallbackRequestHash &&
      // Same rule for the tool-prose rung: enabling or re-pointing it is a
      // request-family change (no options and some options differ). The
      // options are compared as canonicalJson gives them, since a record read
      // back from the store has their keys in another order than
      // toolProseHoistOptions builds them in.
      canonicalJson(active.record.normalizedConfig?.toolProseFallback ?? null) ===
        canonicalJson(record.normalizedConfig.toolProseFallback ?? null),
    );
    return projection.get(record.key)
      ?? sameRegime.find((active) => active.record.familyKey === record.familyKey)
      ?? (sameRegime.length >= AutobiographicalStrategy.CHUNK_QUARANTINE_SHAPE_CAP ? sameRegime[0] : undefined);
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
    // The strategy's own generation is compared first, so once it is
    // detached or reinitialized no check reads the store, which its manager
    // may have closed by then.
    if (!identity || !this.store || this.compressionBranchGeneration !== identity.strategyGeneration) return false;
    const observed = observeStoreBranch(this.store);
    return this.store === identity.store &&
      this.ns === identity.namespace &&
      this.store.currentBranch().name === identity.name &&
      observed.name === identity.name &&
      observed.generation === identity.generation;
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
    // Generation first, as in isBranchIdentityCurrent.
    if (!this.store || this.compressionBranchGeneration !== source.strategyGeneration) return false;
    const observed = observeStoreBranch(this.store);
    return this.store.currentBranch().name === source.name &&
      observed.name === source.name &&
      observed.generation === source.generation;
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
        // The store is read only while the strategy's generation is the
        // work's: a strategy detached since may have no open store.
        ...(this.store && this.compressionBranchGeneration === source.strategyGeneration
          ? {
              current_branch: this.store.currentBranch().name,
              current_generation: observeStoreBranch(this.store).generation,
            }
          : {}),
        current_strategy_generation: this.compressionBranchGeneration,
        ...(record ? { quarantine_key: record.key, canonical_request_hash: record.canonicalRequestHash } : {}),
      },
    }, this.ns);
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

  /** How many quarantine records exist, for a health read that needs only the
   *  count, or what kept the ledger from being read. Never throws. */
  private compressionQuarantineRecordCount(): { count: number } | { error: unknown } {
    if (!this.store) return { count: 0 };
    try {
      return { count: this.readCompressionQuarantineProjection().size };
    } catch (error) {
      return { error };
    }
  }

  /**
   * Public quarantine status for health surfaces (/healthz, fleet-watch,
   * connectome-doctor) and the repeating alarm below.
   */
  getCompressionQuarantineStatus(now: number = Date.now()): CompressionQuarantineStatus {
    return this.readCompressionQuarantineStatus(now).status;
  }

  /**
   * The status, and the error when the quarantine couldn't be read, which the
   * alarm logs. Health reads must never throw, so a read that fails comes
   * back with `unreadable` set, which tells it from an empty quarantine.
   */
  private readCompressionQuarantineStatus(now: number): { status: CompressionQuarantineStatus; error?: unknown } {
    if (!this.store) return { status: { count: 0, keys: [], spans: [] } };
    try {
      const projection = this.readCompressionQuarantineProjection();
      if (projection.size === 0) return { status: { count: 0, keys: [], spans: [] } };
      // A span can hold one record per request shape it exhausted
      // (CHUNK_QUARANTINE_SHAPE_CAP), so records overstate how many spans are
      // stuck. Each span is named by the current chunk whose message ids its
      // records hash, and dated by those messages' timestamps, not by its
      // records: a chunk re-cut into new records still shows how long its
      // messages have stayed raw.
      const chunksByHash = new Map(
        this.chunks.map((chunk) => [sha256Json(chunk.messages.map((message) => message.id)), chunk] as const),
      );
      const spans = new Map<string, CompressionQuarantineSpan>();
      const newest = new Map<string, number>();
      for (const active of projection.values()) {
        const hash = active.record.chunkSourceHash;
        let span = spans.get(hash);
        if (!span) {
          const chunk = chunksByHash.get(hash);
          const closedAt = chunk ? chunkClosedAtMs(chunk.messages) : undefined;
          span = {
            chunkSourceHash: hash,
            firstMessageId: chunk?.messages[0]?.id ?? null,
            lastMessageId: chunk?.messages[chunk.messages.length - 1]?.id ?? null,
            closedAgeMs: closedAt === undefined ? null : Math.max(0, now - closedAt),
            quarantinedAt: active.record.created,
            records: 0,
            answeredAttempts: 0,
            latestOutcome: null,
          };
          spans.set(hash, span);
        }
        span.records += 1;
        // Count what a provider answered: not a recall variant planned over
        // the compression's context budget, recorded as admission_rejected and
        // never sent, and not a rung its failures decided, which no provider
        // gave as an answer.
        span.answeredAttempts += active.outcomes.filter(
          (entry) => entry.outcome !== 'admission_rejected' && !isFailureDecision(entry),
        ).length;
        span.quarantinedAt = Math.min(span.quarantinedAt, active.record.created);
        if (active.record.created >= (newest.get(hash) ?? -Infinity)) {
          newest.set(hash, active.record.created);
          const last = active.outcomes[active.outcomes.length - 1];
          span.latestOutcome = !last ? null : last.errorType ? `${last.outcome}:${last.errorType}` : last.outcome;
        }
      }
      return {
        status: {
          count: projection.size,
          keys: [...projection.keys()],
          spans: [...spans.values()].sort((a, b) => (b.closedAgeMs ?? -1) - (a.closedAgeMs ?? -1)),
        },
      };
    } catch (error) {
      return { status: { count: 0, keys: [], spans: [], unreadable: true }, error };
    }
  }

  private quarantineAlarmLastAt = 0;
  /** True while an alarm episode is open (alarmed and not yet all-cleared). */
  private quarantineAlarmActive = false;
  /**
   * The quarantine the open episode's alarm last sounded on, by namespace and
   * branch: its all-clear is said only when that quarantine reads empty. Not
   * by store object, which reopening the same store replaces.
   */
  private quarantineAlarmScope: { ns: string; branch: string } | null = null;
  /** When the alarm last said the status couldn't be read, on a clock of its own so the alarm's repeat keeps its time. */
  private quarantineUnreadableSaidAt = 0;
  /** When tick last swept ladder progress (sweepCompressionProgressIfDue). */
  private compressionProgressSweptAt = 0;
  private onQuarantineAlarm?: (status: CompressionQuarantineStatus) => void;
  /** Where a load-repair report goes (setLoadRepairHandler); unset, reports are held. */
  private onLoadRepair?: (report: LoadRepairReport) => unknown;
  /** Load-repair reports not yet handed to a handler, oldest first: in memory only. */
  private heldLoadRepairs: LoadRepairReport[] = [];
  /** The newest load-repair report this instance has made (getLatestLoadRepairReport). */
  private latestLoadRepair: LoadRepairReport | null = null;

  /**
   * Host wiring point: the framework maps this to its ops-alert channel
   * (failures.log + ops:alert trace + webhook). The strategy still emits a
   * loud stderr line on every alarm even when no handler is set, so an
   * unwired deployment cannot fail silently.
   *
   * Called with `count > 0` for each repeating alarm, and ONCE with
   * `count === 0` when an alarm episode ends (the quarantine it spoke of is
   * empty) — hosts should route the all-clear under a DISTINCT alert kind so a
   * same-kind cooldown cannot swallow it. The alarm speaks of the quarantine
   * the strategy is reading: an episode follows the namespace and branch its
   * alarm last sounded on, and only that quarantine reading empty ends it.
   * Not called while the status can't be read (`unreadable`), or while the
   * strategy reads another branch or namespace whose quarantine is empty,
   * since neither says the episode's quarantine is; the stderr line says
   * which.
   */
  setQuarantineAlarmHandler(fn: (status: CompressionQuarantineStatus) => void): void {
    this.onQuarantineAlarm = fn;
  }

  /**
   * Host wiring point for telling whoever keeps the agent that a load's
   * repair of the summary state dropped summaries holding text: memory that
   * changed, which the repair's diagnostic line alone doesn't reach anyone
   * with (context-manager#175). A load (loadPersistedState) runs at each
   * initialization (an open, a branch switch, a fork, setStrategy) and at
   * each take-up of what another instance on the store wrote. A repair that
   * drops only empty summaries, or none, loses no text and makes no report.
   *
   * A host that sets this after the store's open, as one that wires its
   * handlers once the manager is open does, has missed that load, so reports
   * made while none is set are held, in memory only, and setting a handler
   * hands it each of them at once, oldest first. A report made while one is
   * set goes to it once its load's synchronous run has ended: a microtask
   * later, or, for a load a handler runs itself, when that handler returns.
   * So a handler that calls back into the manager, such as to switch
   * branches, never meets a load partway. It can meet an operation that ran
   * the load and is still going, as any caller between that operation's
   * steps can: an initialization, which keeps the manager's operations
   * fenced until it has finished, or a compression that took up the store's
   * state (takeUpStoreState). Each strategy instance holds its own. A throw
   * from `fn`, or a rejection of what it returns (a promise or any
   * thenable), is logged, and stops neither the load nor the next report.
   * The report isn't handed over again, and the getter gives it until a
   * newer one.
   */
  setLoadRepairHandler(fn: (report: LoadRepairReport) => unknown): void {
    this.onLoadRepair = fn;
    this.handHeldLoadRepairs();
  }

  /**
   * The newest load-repair report this instance has made, whether held or
   * handed on, for a health surface to show; null until a load it ran makes
   * one (setLoadRepairHandler). A load that drops summaries holding text
   * makes none only where the store's branch or sequence can't be read,
   * which is logged.
   */
  getLatestLoadRepairReport(): LoadRepairReport | null {
    return this.latestLoadRepair;
  }

  /**
   * A load-repair report, queued for the handler: one already set takes it
   * a microtask later, once the load's synchronous run has ended, and one
   * set later takes it when it's set (setLoadRepairHandler).
   */
  private deliverLoadRepair(report: LoadRepairReport): void {
    this.latestLoadRepair = report;
    this.heldLoadRepairs.push(report);
    if (this.onLoadRepair) queueMicrotask(() => this.handHeldLoadRepairs());
  }

  /**
   * Each queued report to the handler set when it's taken, oldest first,
   * those queued meanwhile included.
   */
  private handHeldLoadRepairs(): void {
    while (this.onLoadRepair && this.heldLoadRepairs.length > 0) {
      this.handLoadRepair(this.onLoadRepair, this.heldLoadRepairs.shift()!);
    }
  }

  private handLoadRepair(fn: (report: LoadRepairReport) => unknown, report: LoadRepairReport): void {
    const failed = (error: unknown): void => this.diag.warn(
      `[autobiographical] the load-repair handler failed on the report for ${report.stateId} on branch ${report.branch} at sequence ${report.sequenceBefore}:`, error,
    );
    try {
      // Promise.resolve adopts a promise from another realm or a library's
      // thenable as well as this realm's, and passes anything else through.
      Promise.resolve(fn(report)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /**
   * The report of a load's repair that dropped summaries holding text
   * (LoadRepairReport), read before the repair writes: `drops` in the order
   * of `ids`, the summary ids as stored. Undefined where the store's branch
   * or sequence can't be read, which is logged: the repair goes ahead either
   * way. A range end whose time can't be read has a null time.
   */
  private loadRepairReport(
    store: JsStore,
    ids: readonly string[],
    drops: ReadonlyMap<string, { summary: SummaryEntry; reason: LoadRepairDropReason }>,
    emptyDropped: number,
  ): LoadRepairReport | undefined {
    try {
      const messages = this.hostContext?.messageStore;
      // A view that throws, or an invalid Date's toISOString, gives null.
      const storedAt = (id: string): string | null => {
        try {
          return messages?.get(id)?.timestamp.toISOString() ?? null;
        } catch {
          return null;
        }
      };
      // Loaded state is untyped: a number field that isn't one is null. (The
      // store holds JSON, which refuses NaN and the infinities.)
      const numberOrNull = (value: unknown): number | null => typeof value === 'number' ? value : null;
      const dropped: LoadRepairDroppedSummary[] = [];
      for (const id of ids) {
        const drop = drops.get(id);
        if (!drop) continue;
        const { summary, reason } = drop;
        // The range the repair held for it: its chosen copy's, or another
        // copy's where the repair rebuilt it from one. A summary whose
        // sources can't be read can still hold a readable range.
        const range = isReadableRange(summary.sourceRange) ? summary.sourceRange : null;
        dropped.push({
          id: String(id),
          level: numberOrNull(summary.level),
          tokens: numberOrNull(summary.tokens),
          reason,
          sourceRange: range && { first: range.first, last: range.last, firstAt: storedAt(range.first), lastAt: storedAt(range.last) },
        });
      }
      return {
        namespace: this.ns,
        branch: store.currentBranch().name,
        stateId: this.summariesStateId,
        sequenceBefore: store.currentSequence(),
        dropped,
        droppedTokens: dropped.reduce((sum, d) => sum + (d.tokens ?? 0), 0),
        emptyDropped,
      };
    } catch (error) {
      this.diag.warn('[autobiographical] a load\'s repair drops summaries holding text, and its report couldn\'t be read:', error);
      return undefined;
    }
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
    const sweptIdentity = this.loadedBranchIdentity;
    await this.sweepPaidOffQuarantineRecords();
    // A strategy detached, or loaded again on another branch, during the
    // sweep sounds no alarm for the branch it swept.
    if (this.loadedBranchIdentity !== sweptIdentity || !this.isLoadedBranchCurrent()) return;
    const { status, error } = this.readCompressionQuarantineStatus(now);
    if (status.unreadable) {
      // A read that failed says nothing about the debt, so the episode, its
      // repeat clock and the handler stay as they were. Said once an
      // interval, on a clock of its own.
      if (now - this.quarantineUnreadableSaidAt < interval) return;
      this.quarantineUnreadableSaidAt = now;
      this.diag.error(
        `[compression-quarantine] ⚠️ quarantine status unreadable; the alarm stays ${this.quarantineAlarmActive ? 'up' : 'down'} until a read succeeds:`,
        error,
      );
      return;
    }
    const scope = { ns: this.ns, branch: this.store?.currentBranch().name ?? '' };
    if (status.count === 0) {
      // All-clear must travel the SAME channel the alarm did — after an
      // alarm, silence is ambiguous (debt paid? alarm path dead?). Fires
      // once per episode, immediately on the emptying tick.
      if (this.quarantineAlarmActive) {
        const episode = this.quarantineAlarmScope;
        if (episode && (episode.ns !== scope.ns || episode.branch !== scope.branch)) {
          // The alarm spoke of a quarantine this strategy isn't reading now,
          // whose debt isn't known to be paid. The episode stays open, to end
          // when that quarantine reads empty, and says so at the alarm's
          // interval, with no handler call.
          if (now - this.quarantineAlarmLastAt < interval) return;
          this.quarantineAlarmLastAt = now;
          // Namespaces are named on both sides when they differ.
          const where = (at: { ns: string; branch: string }): string =>
            `branch '${at.branch}'${episode.ns === scope.ns ? '' : ` of '${at.ns}'`}`;
          this.diag.error(
            `[compression-quarantine] ⚠️ the alarm for ${where(episode)} stays up while the strategy reads ${where(scope)}, ` +
              `whose quarantine is empty; it ends with the all-clear when the strategy reads ${where(episode)} empty`,
          );
          return;
        }
        this.quarantineAlarmActive = false;
        this.quarantineAlarmLastAt = 0;
        this.diag.error(
          '[compression-quarantine] ✅ ALL CLEAR — quarantine empty, debt paid; alarm stands down',
        );
        try {
          this.onQuarantineAlarm?.(status);
        } catch (error) {
          this.diag.error('[compression-quarantine] all-clear handler failed:', error);
        }
      }
      return;
    }
    if (this.quarantineAlarmActive && now - this.quarantineAlarmLastAt < interval) return;
    this.quarantineAlarmActive = true;
    this.quarantineAlarmLastAt = now;
    this.quarantineAlarmScope = scope;
    // Two clocks, each labelled: how long since the span's chunk closed (how
    // long it has stayed raw), and when its earliest record was made (how
    // long it has been refused).
    const age = (ms: number | null): string =>
      ms === null ? 'close time unknown'
        : `closed ${ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`} ago`;
    // A record's created time is read from the ledger unchecked: a value no
    // Date can hold (NaN, infinite, or past its range) shows as unknown
    // rather than throwing at the top of every tick.
    const since = (at: number): string => {
      const date = new Date(at);
      return Number.isNaN(date.getTime()) ? 'refusing since unknown' : `refusing since ${date.toISOString().slice(0, 16)}Z`;
    };
    const spans = status.spans.map((span) =>
      `${span.firstMessageId ?? '?'}..${span.lastMessageId ?? '?'} (${age(span.closedAgeMs)}, ${since(span.quarantinedAt)}, ` +
        `${span.records} record${span.records === 1 ? '' : 's'}, ${span.answeredAttempts} answered` +
        `${span.latestOutcome ? `, last ${span.latestOutcome}` : ''})`,
    );
    this.diag.error(
      `[compression-quarantine] ⚠️ ${status.spans.length} span(s) in compression quarantine ` +
        `(${status.count} record(s)) — their spans stay raw and WILL eventually exhaust the context budget. ` +
        `Operator action required (inspect refusing content; branch, pin, or clear). ` +
        `spans: ${spans.join('; ')}. keys=${status.keys.map(k => k.slice(0, 12)).join(',')}`,
    );
    try {
      this.onQuarantineAlarm?.(status);
    } catch (error) {
      this.diag.error('[compression-quarantine] alarm handler failed:', error);
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
    const identity = this.loadedBranchIdentity;
    let projection: Map<string, ActiveCompressionQuarantine>;
    try {
      projection = this.readCompressionQuarantineProjection();
    } catch {
      // The status read that follows fails the same way, and the alarm says
      // so at its own interval rather than at every tick of an open episode.
      return;
    }
    try {
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
        // A strategy detached, loaded again on another branch, or whose
        // branch moved, while a clear waited stops sweeping here: that clear
        // may have written nothing, the chunk records read above are another
        // branch's, and the records stay for the next sweep.
        if (this.loadedBranchIdentity !== identity || !this.isLoadedBranchCurrent()) return;
        this.diag.error(`[compression-quarantine] cleared ${key.slice(0, 12)}… — ${reason}`);
      }
    } catch (error) {
      this.diag.warn('[compression-quarantine] paid-off sweep failed (records remain, klaxon persists):', error);
    }
  }

  /**
   * Sweep ladder progress on its own cadence, from tick: at most every
   * COMPRESSION_PROGRESS_SWEEP_INTERVAL_MS, whatever the quarantine alarm's
   * state (it can be off, and an active alarm would otherwise sweep on every
   * tick), and a slot with no progress costs one small read.
   */
  private sweepCompressionProgressIfDue(ctx: StrategyContext): void {
    const now = Date.now();
    if (now - this.compressionProgressSweptAt < AutobiographicalStrategy.COMPRESSION_PROGRESS_SWEEP_INTERVAL_MS) return;
    this.compressionProgressSweptAt = now;
    this.sweepPaidOffCompressionProgress(ctx);
  }

  /**
   * Drop ladder progress that can never be resumed, or that nothing has
   * advanced for COMPRESSION_PROGRESS_MAX_AGE_MS (a family abandoned when its
   * chunk's boundaries or the recall frontier moved). A span is judged by
   * the persisted chunk records, never blind:
   *  - matching record, compressed → covered: drop;
   *  - matching record, raw → live: keep;
   *  - no matching record → drop only when the span is known to be paid
   *    off: every message of it is covered by an L1, or one of its messages
   *    is gone from the store, so no chunk can be cut with these ids again.
   *    A record can go missing while its chunk lives (records are rewritten
   *    as whole snapshots, and a stale writer can drop one), and dropping
   *    live progress would pay its answered rungs again. An entry that
   *    doesn't carry its span's ids keeps the old rule: dropped.
   */
  private sweepPaidOffCompressionProgress(ctx: StrategyContext): void {
    if (!this.store) return;
    try {
      const progress = this.readCompressionFamilyProgress();
      if (progress.size === 0) return;
      const now = Date.now();
      const aged = (entry: CompressionFamilyProgress): boolean =>
        typeof entry.updated === 'number' && now - entry.updated > AutobiographicalStrategy.COMPRESSION_PROGRESS_MAX_AGE_MS;
      const records = this.store.getStateJson(this.chunksStateId);
      const chunkRecords = Array.isArray(records) ? (records as ChunkRecord[]) : [];
      if (chunkRecords.length === 0) {
        // Nothing to judge spans by (no records yet, or chunk persistence
        // off): only age decides.
        this.forgetCompressionFamilyProgress(aged);
        return;
      }
      const byHash = new Map<string, ChunkRecord>();
      for (const r of chunkRecords) {
        if (r && Array.isArray(r.sourceIds)) byHash.set(sha256Json(r.sourceIds), r);
      }
      // Built only if an entry's record is missing.
      let coveredByL1: Set<string> | null = null;
      let storedIds: Set<string> | null = null;
      const paidOff = (sourceIds: string[]): boolean => {
        if (!coveredByL1) {
          coveredByL1 = new Set<string>();
          for (const summary of this.summaries) {
            if (summary.level === 1 && Array.isArray(summary.sourceIds)) {
              for (const id of summary.sourceIds) coveredByL1.add(id);
            }
          }
        }
        if (sourceIds.length > 0 && sourceIds.every((id) => coveredByL1!.has(id))) return true;
        if (!storedIds) storedIds = new Set(ctx.messageStore.getAll().map((message) => message.id));
        // An empty store says nothing about which messages are gone.
        return storedIds.size > 0 && sourceIds.some((id) => !storedIds!.has(id));
      };
      this.forgetCompressionFamilyProgress((entry) => {
        if (aged(entry)) return true;
        const match = byHash.get(entry.chunkSourceHash);
        if (match) return match.compressed === true;
        return Array.isArray(entry.sourceIds) ? paidOff(entry.sourceIds) : true;
      });
    } catch (error) {
      this.diag.warn(`[autobiographical] compression progress sweep failed (progress remains): ${describeCompressionFailure(error)}`);
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
    const identity = this.loadedBranchIdentity;
    // The span is covered: no family of it needs ladder progress any more.
    const chunkHash = sha256Json(chunk.messages.map((message) => message.id));
    try {
      this.forgetCompressionFamilyProgress((entry) => entry.chunkSourceHash === chunkHash);
    } catch (error) {
      this.diag.warn(`[autobiographical] could not drop compression progress for a compressed chunk: ${describeCompressionFailure(error)}`);
    }
    try {
      const hash = chunkHash;
      const projection = this.readCompressionQuarantineProjection();
      for (const [key, active] of projection) {
        if (active.record.chunkSourceHash !== hash) continue;
        await this.clearCompressionRefusalQuarantine(key);
        // As in the paid-off sweep: a strategy detached, loaded again on
        // another branch, or whose branch moved while a clear waited stops
        // here, since that clear may have written nothing.
        if (this.loadedBranchIdentity !== identity || !this.isLoadedBranchCurrent()) return;
        this.diag.error(
          `[compression-quarantine] cleared ${key.slice(0, 12)}… — its chunk compressed ` +
            `successfully under a newer request shape`,
        );
      }
    } catch (error) {
      this.diag.warn('[compression-quarantine] success-clear failed (records remain, klaxon persists):', error);
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
      namespace: this.ns,
    };
    // Structured and keyed only: no summary/chunk plaintext is emitted.
    console.error(JSON.stringify(payload));
    logCompressionCall(payload, this.ns);
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
          }, this.ns);
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

  /**
   * Quarantine a family whose ladder ended with no summary, with its record
   * (`outcomes`), and say what became of it:
   *  - 'written': the record is written, with its alert;
   *  - 'held': the ledger already holds a record under this key, which
   *    stands, and nothing is written. In this process a ladder never runs
   *    for a quarantined chunk, so only another process can have written it;
   *  - 'dropped': `familyOpen` says the family was dropped while its ladder
   *    ran (minted, cleared or swept), and it isn't brought back.
   * Both are asked under the ledger's lock, the lock an operator's clear
   * drops a family's progress under, the held key first, so a family another
   * process quarantined isn't reported dropped. A drop before the ladder
   * first saw its family's progress isn't seen (see familyOpen's comment).
   * Undefined when nothing was decided: with no store, or when the branch
   * stopped being current, which the caller checks after.
   */
  private async exhaustCompressionRequestFamily(
    source: CompressionOperationBranch,
    record: CompressionRefusalQuarantineRecord,
    outcomes: CompressionRefusalOutcomeRecord[],
    familyOpen: () => boolean,
  ): Promise<'written' | 'held' | 'dropped' | undefined> {
    if (!this.store) return undefined;
    let exhaustion: 'written' | 'held' | 'dropped' | undefined;
    await withCompressionStateLock(
      this.store,
      source.name,
      this.compressionRefusalQuarantineLedgerStateId,
      () => {
      if (!this.isCompressionBranchCurrent(source)) return;
      const current = this.readCompressionQuarantineProjection();
      if (current.has(record.key)) {
        exhaustion = 'held';
        return;
      }
      if (!familyOpen()) {
        exhaustion = 'dropped';
        return;
      }
      const exhausted = this.appendCompressionQuarantineEvent({
        kind: 'exhausted', key: record.key, record, outcomes, created: Date.now(),
      });
      exhaustion = 'written';
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
    return exhaustion;
  }

  /** A ladder ended with no summary on a family dropped while it ran: it writes no record. */
  private logCompressionFamilyDropped(chunk: Chunk, record: CompressionRefusalQuarantineRecord): void {
    this.diag.warn(
      `[autobiographical] the ladder for the chunk from ${chunk.messages[0]?.id ?? '?'} ended with no summary ` +
        'and quarantines nothing: its family was dropped while it ran (minted, cleared or swept)',
    );
    logCompressionCall({
      event: 'compression:family-dropped',
      operation: 'compress_l1',
      metadata: { quarantine_key: record.key, family_key: record.familyKey },
    }, this.ns);
  }

  private readCompressionFamilyProgress(): Map<string, CompressionFamilyProgress> {
    const progress = new Map<string, CompressionFamilyProgress>();
    if (!this.store) return progress;
    const stored = this.store.getStateJson(this.compressionFamilyProgressStateId);
    for (const entry of Array.isArray(stored) ? stored : []) {
      const candidate = entry as Partial<CompressionFamilyProgress> | null;
      if (
        candidate &&
        typeof candidate.familyKey === 'string' &&
        typeof candidate.chunkSourceHash === 'string' &&
        Array.isArray(candidate.outcomes)
      ) {
        progress.set(candidate.familyKey, candidate as CompressionFamilyProgress);
      }
    }
    return progress;
  }

  /**
   * Durable before the next rung's call: written and synced, so a crash
   * after it never re-pays a request whose answer it records. Only work on
   * the current branch writes; stale-branch work leaves nothing.
   *
   * The slot is shared by every strategy on this store and namespace (each
   * reads it afresh; nothing is cached per instance), so each write is a
   * read-merge-write of this family alone: other families are kept as the
   * slot holds them, and answers another writer recorded for this family
   * are kept beside this ladder's. The read and the write are synchronous,
   * with no await between them.
   */
  private recordCompressionFamilyProgress(
    source: CompressionOperationBranch,
    record: CompressionRefusalQuarantineRecord,
    outcomes: CompressionRefusalOutcomeRecord[],
    canonicalProviderInputTokens: number | undefined,
    sourceOnlyProviderInputTokens: number | undefined,
    sourceIds: readonly string[],
  ): void {
    if (!this.store || !this.isCompressionBranchCurrent(source)) return;
    const progress = this.readCompressionFamilyProgress();
    const existing = progress.get(record.familyKey);
    const answerKey = (outcome: CompressionRefusalOutcomeRecord): string => `${outcome.curveLabel}\u0000${outcome.requestHash}`;
    const merged = new Map<string, CompressionRefusalOutcomeRecord>();
    for (const outcome of existing?.outcomes ?? []) merged.set(answerKey(outcome), outcome);
    for (const outcome of outcomes) if (!merged.has(answerKey(outcome))) merged.set(answerKey(outcome), { ...outcome });
    const tokens = canonicalProviderInputTokens ?? existing?.canonicalProviderInputTokens;
    const sourceOnlyTokens = sourceOnlyProviderInputTokens ?? existing?.sourceOnlyProviderInputTokens;
    progress.set(record.familyKey, {
      familyKey: record.familyKey,
      chunkSourceHash: record.chunkSourceHash,
      sourceIds: [...sourceIds],
      outcomes: [...merged.values()],
      ...(tokens !== undefined ? { canonicalProviderInputTokens: tokens } : {}),
      ...(sourceOnlyTokens !== undefined ? { sourceOnlyProviderInputTokens: sourceOnlyTokens } : {}),
      updated: Date.now(),
    });
    this.writeCompressionFamilyProgress(progress);
  }

  private writeCompressionFamilyProgress(progress: Map<string, CompressionFamilyProgress>): void {
    if (!this.store) return;
    this.store.setStateJson(this.compressionFamilyProgressStateId, [...progress.values()]);
    this.store.sync();
  }

  /**
   * Drop progress at a meaningful boundary (mint, exhaustion, an operator's
   * clear, an age or paid-off sweep): read afresh, remove only the matching
   * families, keep every other writer's.
   */
  private forgetCompressionFamilyProgress(matches: (entry: CompressionFamilyProgress) => boolean): void {
    if (!this.store) return;
    const progress = this.readCompressionFamilyProgress();
    let changed = false;
    for (const [key, entry] of progress) {
      if (!matches(entry)) continue;
      progress.delete(key);
      changed = true;
    }
    if (changed) this.writeCompressionFamilyProgress(progress);
  }

  /**
   * The compression lane's pause, if one binds this membrane and compression
   * model now. A pause observed on another membrane instance or model says
   * nothing about this one, so it is ignored and cleared.
   */
  private activeCompressionPause(ctx: StrategyContext): CompressionLanePause | null {
    const pause = this.compressionPause;
    if (!pause) return null;
    if (pause.membrane !== ctx.membrane || pause.model !== this.config.compressionModel) {
      this.compressionPause = null;
      return null;
    }
    return Date.now() < pauseUntil(pause) ? pause : null;
  }

  /**
   * Release the provider's stated wait from the lane's pause: the caller's
   * explicit word that the wait no longer holds (agent-framework calls this
   * when an operator releases a provider wait; the release is recorded
   * there). Only the provider-derived constraint goes: the lane's own
   * backoff still paces it, and with it gone too the lane resumes at once.
   * The failure count is kept (a release is not an answer).
   * `model` limits the release to a pause on that model. True when a stated
   * wait was released.
   */
  releaseCompressionPause(model?: string): boolean {
    const pause = this.compressionPause;
    if (!pause || pause.statedUntil === null) return false;
    if (model !== undefined && pause.model !== model) return false;
    const released = pause.statedBy === 'admission' ? "the caller's cached admission deferral" : "the provider's stated wait";
    pause.statedUntil = null;
    pause.statedBy = null;
    // A hold that continues after the release is news: it warns again.
    delete pause.admissionDeadline;
    // A release is the caller's word on the wait, not an answer from the
    // provider: the failure count stays, so a failure after it keeps doubling
    // the backoff from the genuine count (only an answer resets it).
    if (Date.now() >= pause.backoffUntil) {
      this.diag.warn(`[autobiographical] compression resumed: ${released} was released (failure count ${pause.failures} kept)`);
    } else {
      this.diag.warn(`[autobiographical] ${released} was released; compression stays paused by its backoff ${pauseUntilText(pause)}`);
    }
    return true;
  }

  /**
   * Pause compression calls after a failure that says nothing about the
   * request, until both constraints have passed: the lane's own backoff (5 s
   * doubling to 10 min) and the provider's stated wait, which is never
   * shortened. A stated wait is a non-negative `retryAfterMs`; NaN, or any
   * other value, states none (a garbage value must not hold the lane until a
   * restart). One that cannot be held as an instant (Infinity, or past the
   * last instant a Date can hold) is an explicit hold until a restart, a
   * change of membrane or model, or releaseCompressionPause. The
   * pause belongs to the model the failed call was dispatched with.
   * Discarded or stale-branch work installs nothing. One warning per pause,
   * plus a structured log event (compression:lane-paused); a hold by the
   * caller's provider admission warns and logs (compression:lane-held-by-
   * admission) once per hold, and again when its deadline changes.
   *
   * `madeNoCall`: the failure was another instance's call, on a request this
   * one joined (a coalesced wait). It paces this lane by the provider's
   * stated wait, so this instance doesn't send the same request inside it,
   * and keeps the failure count and the backoff as they were: no call of
   * this instance's failed. With no stated wait, a failure installs nothing.
   * The join is the one caller that passes it, and it passes it for no
   * deferral: a deferral made no call, and the admission's hold above would
   * still install.
   */
  private pauseCompressionLane(
    source: CompressionOperationBranch,
    ctx: StrategyContext,
    error: unknown,
    lane: 'l1' | 'merge',
    subject: string,
    options: { madeNoCall?: boolean } = {},
  ): void {
    if (!this.isCompressionBranchCurrent(source)) return;
    const now = Date.now();
    const model = (error !== null && typeof error === 'object' ? dispatchedCompressionModel.get(error) : undefined)
      ?? this.config.compressionModel;
    const previous = this.compressionPause &&
      this.compressionPause.membrane === ctx.membrane &&
      this.compressionPause.model === model
      ? this.compressionPause
      : null;
    const failures = (previous?.failures ?? 0) + (options.madeNoCall ? 0 : 1);
    const backoff = Math.min(
      AutobiographicalStrategy.COMPRESSION_PAUSE_BASE_MS * 2 ** (failures - 1),
      AutobiographicalStrategy.COMPRESSION_PAUSE_MAX_BACKOFF_MS,
    );
    const stated = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
    let statedUntil: number | null = null;
    if (typeof stated === 'number' && !Number.isNaN(stated) && stated >= 0) {
      const instant = now + stated;
      statedUntil = Number.isFinite(instant) && instant <= MAX_DATE_MS ? instant : Number.POSITIVE_INFINITY;
    }
    // The caller's provider admission deferred this call (agent-framework's
    // refusal of a held model: `providerAdmission: 'deferred'`). No call was
    // made, so nothing failed here: the failure count and the lane's own
    // backoff stay as they were. The admission stays the authority. Its
    // answer is cached until the deadline it gave or for at most
    // COMPRESSION_ADMISSION_RECHECK_MS, whichever is sooner, and the lane
    // then asks again. Asking is not a provider call (the admission refuses
    // again while its wait binds), so a condition that clears with no release
    // reaching this instance (a recovered journal, a release made elsewhere)
    // is observed. A genuine backoff can still postpone the next check, and a
    // wait a provider stated after a real call is never shortened by it.
    if ((error as { providerAdmission?: unknown } | null)?.providerAdmission === 'deferred') {
      const recheckAt = Math.min(
        statedUntil ?? Number.POSITIVE_INFINITY,
        now + AutobiographicalStrategy.COMPRESSION_ADMISSION_RECHECK_MS,
      );
      const pause: CompressionLanePause = previous
        ? { ...previous }
        : { backoffUntil: 0, statedUntil: null, statedBy: null, failures: 0, membrane: ctx.membrane, model, reason: '' };
      if (!(pause.statedBy === 'provider' && pause.statedUntil !== null && pause.statedUntil > recheckAt)) {
        pause.statedUntil = recheckAt;
        pause.statedBy = 'admission';
      }
      pause.reason = describeCompressionFailure(error);
      // One hold, one warning and one log event: the lane asks again every
      // COMPRESSION_ADMISSION_RECHECK_MS at most, and a recheck that finds
      // the same hold under the same deadline says nothing new.
      const last = previous?.admissionDeadline;
      const sameHold = last !== undefined && (
        last === statedUntil ||
        (last !== null && statedUntil !== null &&
          Math.abs(last - statedUntil) <= AutobiographicalStrategy.COMPRESSION_ADMISSION_DEADLINE_SLACK_MS)
      );
      pause.admissionDeadline = statedUntil;
      this.compressionPause = pause;
      if (sameHold) return;
      const deadline = statedUntil === null
        ? 'it gave no deadline'
        : Number.isFinite(statedUntil)
          ? `its deadline is ${new Date(statedUntil).toISOString()}`
          : 'its deadline cannot be held as an instant';
      this.diag.warn(
        `[autobiographical] compression held by the caller's provider admission (no call was made; ${deadline}); ` +
          `next check ${pauseUntilText(pause)} (model ${model ?? 'unset'}, failure count ${pause.failures}): ${pause.reason}`,
      );
      const nextCheck = pauseUntil(pause);
      logCompressionCall({
        event: 'compression:lane-held-by-admission',
        operation: lane === 'l1' ? 'compress_l1' : 'merge',
        metadata: {
          next_check: Number.isFinite(nextCheck) ? new Date(nextCheck).toISOString() : null,
          admission_deadline: statedUntil === null ? null : Number.isFinite(statedUntil) ? new Date(statedUntil).toISOString() : 'unrepresentable',
          failures: pause.failures,
          model: model ?? null,
        },
      }, this.ns);
      return;
    }
    // Another instance's failure gives this lane only its stated wait.
    if (options.madeNoCall && statedUntil === null) return;
    // A stated wait still standing from an earlier failure (or deferral) on
    // this model is not shortened by this one (see the construction below).
    const reason = describeCompressionFailure(error);
    let statedBy: CompressionLanePause['statedBy'] = statedUntil === null ? null : 'provider';
    if (previous?.statedUntil != null && (statedUntil === null || previous.statedUntil > statedUntil)) {
      statedBy = previous.statedBy;
    }
    const pause: CompressionLanePause = {
      backoffUntil: options.madeNoCall ? previous?.backoffUntil ?? 0 : now + backoff,
      statedUntil: previous?.statedUntil != null && (statedUntil === null || previous.statedUntil > statedUntil)
        ? previous.statedUntil
        : statedUntil,
      statedBy,
      failures,
      membrane: ctx.membrane,
      model,
      reason,
      latest: { subject, failureClass: compressionFailureClass(error) },
    };
    this.compressionPause = pause;
    const sourceLabel = pauseSource(pause);
    this.diag.warn(
      options.madeNoCall
        ? `[autobiographical] compression paused ${pauseUntilText(pause)}: another instance's call for the same ` +
          `${lane === 'l1' ? 'chunk' : 'merge'} failed (${pauseSourceText(pause)}; none of this instance's calls failed, ` +
          `so the failure count stays ${failures}, model ${model ?? 'unset'}); ` +
          `no compression call and no further queue item until then: ${reason}`
        : `[autobiographical] compression paused ${pauseUntilText(pause)} after a ${lane === 'l1' ? 'chunk' : 'merge'} failure ` +
          `(${pauseSourceText(pause)}, failure ${failures}, model ${model ?? 'unset'}); ` +
          `no compression call and no further queue item until then: ${reason}`,
    );
    const until = pauseUntil(pause);
    logCompressionCall({
      event: 'compression:lane-paused',
      operation: lane === 'l1' ? 'compress_l1' : 'merge',
      metadata: {
        until: Number.isFinite(until) ? new Date(until).toISOString() : null,
        failures,
        source: sourceLabel,
        model: model ?? null,
        error_type: compressionErrorType(error) ?? (error instanceof Error ? error.name : typeof error),
        ...(options.madeNoCall ? { coalesced: true } : {}),
      },
    }, this.ns);
  }

  /**
   * Put a chunk whose attempt didn't decide it back in the queue, found by its
   * source identity among the current chunks. After a failure it goes behind
   * the work that hasn't failed, so that work runs once the pause ends (and
   * lands, which tells whether the failure is this chunk's own, see
   * nextFailureStreak); a merge spanning it waits for it (see
   * contiguousMergeCandidates). After a deferral, an abort or a host's
   * withdrawal, which say nothing about anything, it keeps its place: at the
   * head, or among the failed if it failed before (orderCompressionQueue).
   * Queued again meanwhile without a rebuild, as a plan's demand queues it
   * at the tail, it moves from the tail to that place, once. A rebuild
   * during the call (`superseded`) re-decided the chunk's eligibility: it is
   * put back only if that rebuild queued it, and a rebuild's withdrawal of
   * it stands.
   */
  private requeuePendingChunk(key: string, place: 'head' | 'back', superseded: boolean): void {
    if (place === 'back') this.compressionFailureOrder.set(key, ++this.compressionFailureSequence);
    const index = this.chunks.findIndex((chunk) => !chunk.compressed && this.chunkKey(chunk) === key);
    if (index >= 0 && !superseded) {
      const queued = this.compressionQueue.indexOf(index);
      if (place === 'head') {
        if (queued !== -1) this.compressionQueue.splice(queued, 1);
        this.compressionQueue.unshift(index);
      } else if (queued === -1) {
        this.compressionQueue.push(index);
      }
    }
    this.orderCompressionQueue();
  }

  /**
   * The compression queue in the order the lane takes it: chunks that haven't
   * failed or been skipped for their quarantine in this process first, in
   * queue order, then those that have, least recently first. Every rebuild
   * applies it too, so a rebuild, which queues chunks in index order, never
   * puts a failed or skipped chunk back at the head.
   * A failure order or a run whose chunk is no longer pending is dropped,
   * and so is one whose merge is no longer queued.
   */
  private orderCompressionQueue(): void {
    const pending = new Set(this.chunks.filter((chunk) => !chunk.compressed).map((chunk) => this.chunkKey(chunk)));
    for (const key of this.compressionFailureOrder.keys()) if (!pending.has(key)) this.compressionFailureOrder.delete(key);
    for (const key of this.compressionNotBefore.keys()) if (!pending.has(key)) this.compressionNotBefore.delete(key);
    for (const [subject, entry] of this.compressionFailureRuns) if (!pending.has(entry.chunkKey)) this.compressionFailureRuns.delete(subject);
    const queuedMerges = new Set(this.mergeQueue.map((merge) => mergeFailureKey(merge)));
    for (const key of this.mergeFailureOrder.keys()) if (!queuedMerges.has(key)) this.mergeFailureOrder.delete(key);
    for (const key of this.mergeFailureRuns.keys()) if (!queuedMerges.has(key)) this.mergeFailureRuns.delete(key);
    // Each queued chunk's failure order, looked up once: a chunk's key joins
    // its message ids, so the sort mustn't recompute it per comparison.
    const failedAt = new Map<number, number>();
    for (const index of this.compressionQueue) {
      const chunk = this.chunks[index];
      const order = chunk ? this.compressionFailureOrder.get(this.chunkKey(chunk)) : undefined;
      if (order !== undefined) failedAt.set(index, order);
    }
    const fresh = this.compressionQueue.filter((index) => !failedAt.has(index));
    const failed = this.compressionQueue
      .filter((index) => failedAt.has(index))
      .sort((a, b) => failedAt.get(a)! - failedAt.get(b)!);
    this.compressionQueue = [...fresh, ...failed];
  }

  /**
   * A compression landed: the provider answered it, and its result is
   * written (an L1 pushed and its chunk record marked, or a merged summary
   * written). A stub, an adoption or a span found covered made no call, so
   * none of them is a landing. It is evidence that its domain answers, which
   * makes the next failure of any OTHER request there count
   * (nextFailureStreak). Called right after the result is written, never at
   * the answer: a crash in between loses a landing, which only makes the
   * next failure not count, and never invents one.
   */
  private noteCompressionLanded(membrane: object, model: string | undefined): void {
    noteDomainLanding(membrane, model);
  }

  /** End the L1 run of `subject` if it is the run of `key`: that rung answered, or its run decided it. */
  private endCompressionFailureRun(subject: string, key: string): void {
    if (this.compressionFailureRuns.get(subject)?.run.key === key) this.compressionFailureRuns.delete(subject);
  }

  /**
   * This process won't retry the request of the chunk keyed `key` while what
   * stopped it lasts: tick found its quarantine and skipped it, the chunk
   * compressed, or its request was found or made unable to go (an exhaustion
   * whose record the ledger holds, a joined call whose family the ledger
   * holds, the overlap guard while the overlap stands).
   * A run holds the summaries beside its chunk's span waiting
   * (pendingRetrySpans) because this process expects to retry the chunk, so
   * every run of the chunk ends, on any rung. A later request shape the
   * durable gate lets through, a retry after a clear, or one after the
   * overlap is mended starts its count afresh, and if the pair beside the
   * span merged meanwhile, its summary lands beside their parent, as after
   * a restart: a lopsided merge, with nothing lost. Says whether a run
   * ended, so the caller can run merge discovery again.
   */
  private endChunkFailureRuns(key: string): boolean {
    let ended = false;
    for (const [subject, entry] of this.compressionFailureRuns) {
      if (entry.chunkKey !== key) continue;
      this.compressionFailureRuns.delete(subject);
      ended = true;
    }
    return ended;
  }

  /**
   * Whether the head of the merge queue takes its turn before an L1 chunk
   * that failed at `failedAt` (a compressionFailureOrder sequence): a merge
   * that hasn't failed since. Fresh L1 work still goes first, as ever; a
   * failed chunk gives way, so its failure doesn't keep the merges from
   * running and landing, which is the evidence that decides it.
   */
  private mergeTakesTurnBefore(failedAt: number, store: MessageStoreView): boolean {
    if (!this.config.hierarchical || this.mergeQueue.length === 0) return false;
    const head = this.mergeQueue[0]!;
    if (this.mergeBlockedByHold(head.sourceIds, store)) return false;
    const mergeFailedAt = this.mergeFailureOrder.get(mergeFailureKey(head));
    return mergeFailedAt === undefined || mergeFailedAt < failedAt;
  }

  /**
   * An answer to one of the lane's calls ends its route's pause and backoff:
   * the pause of the membrane instance and model the answered call went
   * through, on whatever branch. Another route's answer says nothing about this one, so
   * its pause stands.
   */
  private resumeCompressionLane(membrane: object, model: string | undefined): void {
    const pause = this.compressionPause;
    if (!pause || pause.membrane !== membrane || pause.model !== model) return;
    this.diag.warn(`[autobiographical] compression resumed after ${pause.failures} paused failure(s)`);
    this.compressionPause = null;
  }

  /** The model a compression request names, as a pause records it (see pauseCompressionLane). */
  private compressionRequestModel(request: NormalizedRequest): string | undefined {
    const model = (request.config as { model?: unknown } | undefined)?.model;
    return typeof model === 'string' ? model : this.config.compressionModel;
  }

  /**
   * The split-stitch rung's wait for its call window, or null when the window
   * (at most `limit` calls in any `windowMs`, for this instance) has room for
   * `needed` more calls now. The wait runs until enough of the window's calls
   * have aged out of it.
   */
  private splitWindowWait(needed: number, limit: number, windowMs: number): CompressionSplitWindowWait | null {
    const now = Date.now();
    this.splitCallTimes = this.splitCallTimes.filter((t) => now - t < windowMs).sort((a, b) => a - b);
    const excess = this.splitCallTimes.length + needed - limit;
    if (excess <= 0) return null;
    const freeAt = this.splitCallTimes[Math.min(excess, this.splitCallTimes.length) - 1]! + windowMs;
    return new CompressionSplitWindowWait(Math.max(0, freeAt - now), this.splitCallTimes.length, limit, this.splitWindow);
  }

  /** Normalized `compressionToolProseFallback`, or undefined when off/invalid. */
  private toolProseHoistOptions(): ToolProseHoistOptions | undefined {
    const raw = this.config.compressionToolProseFallback;
    if (!raw || typeof raw.intoTool !== 'string' || !raw.intoTool) return undefined;
    if (!Array.isArray(raw.fromTools) || raw.fromTools.length === 0) return undefined;
    return {
      intoTool: raw.intoTool,
      field: raw.field || DEFAULT_TOOL_PROSE_FIELD,
      result: raw.result || DEFAULT_TOOL_PROSE_RESULT,
      minChars: typeof raw.minChars === 'number' && raw.minChars >= 0
        ? raw.minChars
        : DEFAULT_TOOL_PROSE_MIN_CHARS,
      fromTools: [...raw.fromTools],
    };
  }

  /**
   * The request with long private-reasoning tool arguments moved into calls to
   * the configured real tool, or undefined when the rung is off, the target
   * tool is not among the declared tools (never show the summarizer a tool the
   * agent does not have), or nothing qualifies (an identical retry is a burned
   * call). See `tool-prose-hoist.ts`.
   */
  private toolProseHoistedRequest(request: NormalizedRequest): NormalizedRequest | undefined {
    const options = this.toolProseHoistOptions();
    if (!options) return undefined;
    if (!request.tools?.some((tool) => tool.name === options.intoTool)) return undefined;
    const { messages, hoisted } = hoistToolProse(request.messages, options);
    if (hoisted === 0) return undefined;
    return { ...request, messages: messages as NormalizedRequest['messages'] };
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
    sourceOnlyFallbackRequestHash?: string,
  ): CompressionRefusalQuarantineRecord {
    const chunkSourceHash = sha256Json(chunk.messages.map((message) => message.id));
    const frontierHash = sha256Json(
      keptSummaries.map((summary) => ({ id: summary.id, level: summary.level })),
    );
    const fallbackLimit = this.normalizedCompressionFallbackLimit();
    const contextBudgetTokens = this.normalizedCompressionContextBudget();
    const canonicalRequestBoundTokens = this.compressionRequestInputBoundTokens(canonicalRequest);
    const toolProseFallback = this.toolProseHoistOptions();
    const normalizedConfig: CompressionRefusalNormalizedConfig = {
      accountingVersion: COMPRESSION_BUDGET_ACCOUNTING_VERSION,
      fallbackLimit,
      contextBudgetTokens,
      requestConfig: canonicalRequest.config,
      ...(this.config.compressionSourceOnlyFallback === true
        ? { sourceOnlyFallbackEnabled: true }
        : {}),
      ...(sourceOnlyFallbackRequestHash !== undefined
        ? { sourceOnlyFallbackRequestHash }
        : {}),
      // Conditionally spread: with the rung off the record, its key and its
      // family stay byte-identical to what they were before the rung existed.
      ...(toolProseFallback ? { toolProseFallback } : {}),
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
    // in-memory index. loadPersistedState now drops empty and unreadable
    // summaries and persists the canonical array, so its mirror matches the
    // log on load. Cross-instance appends can still change the log afterward.
    // Before that canonical repair, editing by in-memory index wrote
    // merge-updates onto NEIGHBORING entries, silently
    // clobbering them (4 summaries lost in the 2026-07 Lena incident, leaving
    // duplicate-id copies with diverging mergedInto). Update every stored
    // copy with this id so past duplicates converge too.
    const stored = this.store.getStateJson(this.summariesStateId);
    if (!Array.isArray(stored)) return;
    let found = false;
    const payload = storedJson(entry);
    for (let i = 0; i < stored.length; i++) {
      const item = stored[i] as SummaryEntry | null;
      if (item && item.id === entry.id) {
        this.store.editStateItem(this.summariesStateId, i, payload);
        found = true;
      }
    }
    if (!found) {
      this.diag.warn(
        `[autobiographical] setMergedInto: ${entry.id} not found in persisted summary log — merge state not persisted`,
      );
    }
  }

  /**
   * Allocate the next summary-id counter value and persist the new counter.
   */
  protected nextSummaryIdCounter(): number {
    this.requireBranchMutation('nextSummaryIdCounter');
    // Every instance on the store mints from the stored counter, which only
    // rises, so no two of them hand out one id.
    const stored = this.store?.getStateJson(this.counterStateId);
    if (typeof stored === 'number' && stored > this.summaryIdCounter) this.summaryIdCounter = stored;
    const value = this.summaryIdCounter++;
    this.store?.setStateJson(this.counterStateId, this.summaryIdCounter);
    return value;
  }

  /**
   * Push to the merge queue and persist the new queue snapshot.
   *
   * Refused: a group holding a held source (mergeHeldSourceIds: an operator
   * hold, or a source a merge-quarantine record holds out of merges), which
   * the merge candidates already leave out, and a group with a quarantine
   * record of its own (after a merge exhausts its bounded retry policy, it
   * must not be re-enqueued and retried forever) unless it is a valid merge
   * of present, unparented sources. A provider failure's record holds such a
   * group, so only clearMergeQuarantine retries it. A topology refusal's
   * record holds nothing, so its group queues once it is valid again, its
   * sources adjacent once more (say after the messages between them were
   * deleted), when the next merge check or caller offers it: the refusal no
   * longer applies, so the record goes, with a log line. The merge-quarantine
   * klaxon owns visibility; the refusals stay silent.
   */
  protected enqueueMerge(merge: { level: SummaryLevel; sourceIds: string[]; attempts?: number }): void {
    this.requireBranchMutation('enqueueMerge');
    const held = this.mergeHeldSourceIds();
    if (merge.sourceIds.some((id) => held.has(id))) return;
    const key = sha256Json(merge.sourceIds);
    const record = this.mergeQuarantine.get(key);
    if (record) {
      if (!mergeRecordStands(merge, (id) => this.summaryById(id))) return;
      const sources = merge.sourceIds.map((id) => this.summaryById(id)!);
      if (this.mergeTopologyProblem(merge.level, sources, this.mergePositionIndex()) !== null) return;
      this.mergeQuarantine.delete(key);
      this.persistMergeQuarantine();
      this.diag.warn(`[merge-quarantine] cleared topology record key=${key.slice(0, 12)}: its group is a valid merge again`);
    }
    this.mergeQueue.push(merge);
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
  }

  /**
   * Summaries that must not be offered as merge sources: operator holds
   * (`mergeHoldSummaryIds`), and the sources a merge-quarantine record holds
   * out of merges while its group could be retried as it stands
   * (mergeRecordHolds). The merge candidates (contiguousMergeCandidates,
   * enqueueMergeForRange) leave them out, so they split the frontier into
   * runs like any other hole and later history merges around them, and
   * enqueueMerge refuses a group holding one. Offered again, a quarantined
   * group would be refused every time: one refused merge used to stop every
   * merge that would form after it at its level, and froze a resident's whole
   * pyramid for 16 days (322 L1s never attempted, zero merge calls).
   * `position` is the merge position index, when the caller has one.
   */
  protected mergeHeldSourceIds(position?: ReadonlyMap<MessageId, number>): Set<string> {
    const ids = new Set<string>(this.config.mergeHoldSummaryIds ?? []);
    if (this.mergeQuarantine.size === 0) return ids;
    const order = position ?? this.mergePositionIndex();
    for (const record of this.mergeQuarantine.values()) {
      if (!this.mergeRecordHolds(record, order)) continue;
      for (const id of record.sourceIds) ids.add(id);
    }
    return ids;
  }

  /**
   * Whether a merge-quarantine record holds its sources out of merges: its
   * merge failed at the provider (refused, answered unusably or kept failing;
   * not a topology refusal), and its group could be retried as it stands,
   * every source present and unparented and the group still a valid merge in
   * store order (mergeTopologyProblem). A topology refusal made no model
   * call, so its sources merge in valid groups. Neither does a group that
   * can't be retried as it stands hold anything: a source gone or parented
   * (which the sweep, when it runs, deletes), its messages deleted, or a
   * summary landed between its sources. Its remaining sources then merge in
   * valid groups too.
   */
  protected mergeRecordHolds(record: MergeQuarantineRecord, position: ReadonlyMap<MessageId, number>): boolean {
    if (record.lastOutcome === 'topology_violation') return false;
    if (!mergeRecordStands(record, (id) => this.summaryById(id))) return false;
    const sources = record.sourceIds.map((id) => this.summaryById(id)!);
    return this.mergeTopologyProblem(record.level, sources, position) === null;
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

  // ===========================================================================
  // Store topology: contiguity of ownership in STORE order.
  //
  // Merge adjacency used to be judged in chunk-record order. Records are
  // appended when a chunk is minted, so a chunk minted late over an early
  // message (issue #122: the head ratchet peeling opening messages into
  // one-message L1s days later) sat next to the open frontier and merged with
  // it, producing L2/L3s that mix the chronicle's opening with weeks-later
  // material. The demand path (#95) never checked adjacency at all. Every
  // grouping decision and the mint itself now use one index
  // (mergePositionIndex): every message of the store listing at its place.
  // A message no chunk owns renders raw at its own place, between the
  // summaries around it: a raw pin, a message an unpin freed before the
  // chunker reaches it, a head window a reset left mid-stream. A summary
  // across one would hold history from both sides of a message shown between
  // them, and kv-unified's canonical forest, which has a leaf for every listed
  // message, rejects such a node ("owns non-contiguous live leaves") at every
  // compile unless it treeifies or preserves gap-bearing summaries. So such a
  // message keeps the runs on its two sides apart; at the ends of the store
  // (the head window before every chunk, the never-chunked frontier) it
  // splits nothing.
  // The load-time audit judges ownership alone (ownershipPositionIndex): a
  // node minted across such a message before this rule has whole ownership,
  // no owned message between its sources missing, so it stays as it stands,
  // though kv-unified's forest rejects it.
  // ===========================================================================

  /** Store position per message id, refreshed from every listing we see. */
  private _storeOrder = new Map<MessageId, number>();
  /** The listing `_storeOrder` was built from (append-only refreshes extend it). */
  private _storeOrderSource: ReadonlyArray<{ id: MessageId }> = [];
  /** Load-time audit result (see assertStoreTopology). */
  private topologyViolations: TopologyViolation[] = [];

  /** `staticSalience` per position of `messages`, kept across appends (the
   *  earlier positions hold the same message objects, so the same values). */
  private salienceByPosition(messages: readonly StoredMessage[]): Float64Array {
    const memo = this._salience;
    if (memo && memo.listing === messages) return memo.values;
    const values = new Float64Array(messages.length);
    let from = 0;
    if (memo && messages.length >= memo.listing.length) {
      const prev = memo.listing;
      let i = 0;
      while (i < prev.length && messages[i] === prev[i]) i++;
      if (i === prev.length) { values.set(memo.values); from = prev.length; }
    }
    for (let i = from; i < messages.length; i++) values[i] = AutobiographicalStrategy.staticSalience(messages[i]);
    this._salience = { listing: messages, values };
    return values;
  }

  /** id -> index for `messages`: the shared store order when this is the
   *  listing it was refreshed from, else a map built for this call. */
  protected positionIndex(messages: ReadonlyArray<{ id: MessageId }>): ReadonlyMap<MessageId, number> {
    if (messages === this._storeOrderSource) return this._storeOrder;
    const positionOf = new Map<MessageId, number>();
    for (let i = 0; i < messages.length; i++) positionOf.set(messages[i].id, i);
    return positionOf;
  }

  protected refreshStoreOrder(messages: ReadonlyArray<{ id: MessageId }>): void {
    if (messages.length === 0) return;
    const prev = this._storeOrderSource;
    if (messages === prev) return;
    // A listing that keeps every earlier element (same object, so same id
    // and position: the store reuses message objects until an edit) only
    // grew at the end — add the tail instead of rehashing the whole store.
    let from = 0;
    if (prev.length > 0 && messages.length >= prev.length) {
      let i = 0;
      while (i < prev.length && messages[i] === prev[i]) i++;
      if (i === prev.length) from = prev.length;
    }
    // A dry select puts back the order it found, by reference (select()), so
    // it extends a copy instead of writing into that one.
    const order = from === 0
      ? new Map<MessageId, number>()
      : this._dryRunSelect ? new Map(this._storeOrder) : this._storeOrder;
    for (let i = from; i < messages.length; i++) order.set(messages[i].id, i);
    this._storeOrder = order;
    this._storeOrderSource = messages;
  }

  /**
   * Position per message for merge grouping: every message of the last
   * listing at its place, whether a chunk owns it or not, then any chunk
   * member that listing did not contain (appended since) after it, in record
   * order. Two summaries are adjacent exactly when no listed message stands
   * between their sources. Without any listing (hosts that drive the
   * grouping without a store view) this degrades to record order, as
   * ownershipPositionIndex does.
   */
  protected mergePositionIndex(): Map<MessageId, number> {
    const { members, chunkMember } = this.ownedMembers();
    const order = this._storeOrder;
    if (order.size === 0) return new Map(members.map((id, i) => [id, i] as const));
    const index = new Map(order);
    let position = this._storeOrderSource.length;
    for (const id of members) if (!index.has(id) && chunkMember.has(id)) index.set(id, position++);
    return index;
  }

  /**
   * Position per owned message id alone (chunk records ∪ live L1 sourceIds):
   * store order where known, then any chunk member the last listing did not
   * contain after it, in record order. The load-time audit's index
   * (auditStoreTopology), which judges whether each summary's ownership is
   * whole. A summary minted across a message no chunk owns, before merges
   * were kept apart at one, still has whole ownership (no owned message
   * between its sources is missing), so the audit leaves it as it stands,
   * though kv-unified's forest finds its live leaves non-contiguous.
   */
  protected ownershipPositionIndex(): Map<MessageId, number> {
    const { members, chunkMember } = this.ownedMembers();
    const order = this._storeOrder;
    if (order.size === 0) return new Map(members.map((id, i) => [id, i] as const));
    const known = members.filter((id) => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
    const index = new Map<MessageId, number>();
    let position = 0;
    for (const id of known) index.set(id, position++);
    // A chunk member the listing lacks was appended since that listing: it
    // is newer than everything listed. An L1 source the listing lacks is
    // hidden (viewFilter) or pruned: it occupies no position at all.
    for (const id of members) if (!index.has(id) && chunkMember.has(id)) index.set(id, position++);
    return index;
  }

  /** Owned message ids, chunk members first, then live L1 sources: ownership
   *  authority is chunk members ∪ live L1 sourceIds (an L1 is coverage even
   *  where its chunk record is missing; see ownedMessageIds). */
  private ownedMembers(): { members: MessageId[]; chunkMember: Set<MessageId> } {
    const chunkMember = new Set<MessageId>();
    const members: MessageId[] = [];
    for (const ch of this.chunks) for (const m of ch.messages) if (!chunkMember.has(m.id)) { chunkMember.add(m.id); members.push(m.id); }
    const seen = new Set(chunkMember);
    for (const id of this.liveL1Ids()) {
      const s = this.summaryById(id);
      if (!s) continue;
      for (const leaf of s.sourceIds) if (!seen.has(leaf)) { seen.add(leaf); members.push(leaf); }
    }
    return { members, chunkMember };
  }

  /** First live L1 per message id (the fold-path fallback in selectAdaptive),
   *  rebuilt only when the summary list's entries change. */
  private _l1ByMessage: { entries: readonly SummaryEntry[]; map: Map<MessageId, SummaryId> } | null = null;
  private l1ByMessageIndex(): Map<MessageId, SummaryId> {
    const memo = this._l1ByMessage;
    const current = this.summaries;
    if (memo && memo.entries.length === current.length && memo.entries.every((s, i) => s === current[i])) return memo.map;
    const map = new Map<MessageId, SummaryId>();
    for (const s of current) {
      if (s.level !== 1) continue;
      for (const mid of s.sourceIds) {
        if (!map.has(mid)) map.set(mid, s.id);
      }
    }
    this._l1ByMessage = { entries: [...current], map };
    return map;
  }

  private _summaryIndex: { source: readonly SummaryEntry[]; length: number; byId: Map<string, SummaryEntry> } | null = null;
  private summaryById(id: string): SummaryEntry | undefined {
    const cached = this._summaryIndex;
    if (!cached || cached.source !== this.summaries || cached.length !== this.summaries.length) {
      this._summaryIndex = { source: this.summaries, length: this.summaries.length, byId: new Map(this.summaries.map((s) => [s.id, s] as const)) };
    }
    return this._summaryIndex!.byId.get(id);
  }

  /**
   * The L1s that are ownership: those a chunk record points at. Legacy
   * archives keep superseded L1 generations (prefix families the migration
   * sweep skipped); they are prose, not coverage. Without any chunk→L1 link
   * (a strategy driven without records) every L1 counts.
   */
  protected liveL1Ids(): Set<string> {
    const linked = new Set<string>();
    for (const ch of this.chunks) if (ch.summaryId) linked.add(ch.summaryId);
    if (linked.size > 0) return linked;
    const all = new Set<string>();
    for (const s of this.summaries) if (s.level === 1) all.add(s.id);
    return all;
  }

  /** Split same-level sources into strictly adjacent runs (store order). Sources
   *  whose range endpoints have no position are left out of every run. */
  protected contiguousSourceRuns(
    sources: readonly SummaryEntry[],
    position: ReadonlyMap<MessageId, number>,
  ): SummaryEntry[][] {
    const placed: Array<{ s: SummaryEntry; first: number; last: number }> = [];
    for (const s of sources) {
      const a = position.get(s.sourceRange.first);
      const b = position.get(s.sourceRange.last);
      if (a === undefined || b === undefined) continue;
      placed.push({ s, first: Math.min(a, b), last: Math.max(a, b) });
    }
    placed.sort((x, y) => x.first - y.first);
    const runs: SummaryEntry[][] = [];
    let run: SummaryEntry[] = [];
    let end = -Infinity;
    for (const p of placed) {
      if (run.length > 0 && p.first !== end + 1) { runs.push(run); run = []; }
      run.push(p.s);
      end = Math.max(end, p.last);
    }
    if (run.length > 0) runs.push(run);
    return runs;
  }

  /** Why this group must not be merged into an L{targetLevel}, or null when it may. */
  protected mergeTopologyProblem(
    targetLevel: number,
    sources: readonly SummaryEntry[],
    position: ReadonlyMap<MessageId, number>,
  ): string | null {
    if (sources.length < 2) return `${sources.length} source(s); a merge needs at least two`;
    const wrongLevel = sources.filter((s) => s.level !== targetLevel - 1);
    if (wrongLevel.length > 0) {
      return `source level mismatch: ${wrongLevel.map((s) => `${s.id}=L${s.level}`).join(',')} for an L${targetLevel} merge`;
    }
    const unplaced = sources.filter((s) =>
      position.get(s.sourceRange.first) === undefined || position.get(s.sourceRange.last) === undefined);
    if (unplaced.length > 0) {
      return `source position unresolved (range endpoints neither in the store listing nor owned by a chunk): ${unplaced.map((s) => s.id).join(',')}`;
    }
    const runs = this.contiguousSourceRuns(sources, position);
    if (runs.length !== 1) {
      return `sources are not adjacent in store order: ` +
        runs.map((r) => `[${r.map((s) => `${s.id}(${s.sourceRange.first}..${s.sourceRange.last})`).join(',')}]`).join(' | ');
    }
    return null;
  }

  /** The merge is never executed: no model call, the group stays unmerged,
   *  the entry moves into the durable merge quarantine, health goes critical.
   *  The record holds nothing (mergeRecordHolds), so its sources can merge in
   *  valid groups, and it goes once its own group queues as a valid merge
   *  (enqueueMerge), the sweep finds a source parented or gone, or an
   *  operator clears it. */
  protected refuseCrossedMerge(targetLevel: SummaryLevel, sourceIds: string[], reason: string): void {
    this.requireBranchMutation('refuseCrossedMerge');
    const head = this.mergeQueue[0];
    const entry = head && head.sourceIds === sourceIds ? head : { level: targetLevel, sourceIds, attempts: 0 };
    if (entry === head) this.dequeueMerge();
    const record: MergeQuarantineRecord = {
      key: sha256Json(sourceIds),
      level: targetLevel,
      sourceIds: [...sourceIds],
      attempts: entry.attempts ?? 0,
      lastOutcome: 'topology_violation',
      lastErrorType: reason,
      quarantinedAt: Date.now(),
    };
    this.mergeQuarantine.set(record.key, record);
    this.persistMergeQuarantine();
    this.diag.error(
      `[merge-topology] ⛔ refused L${targetLevel} merge over ${sourceIds.length} source(s) ` +
        `(${sourceIds.join(', ')}): ${reason}. The node was NOT minted; entry quarantined ` +
        `(key=${record.key.slice(0, 12)}). Inspect the store, then clearMergeQuarantine.`,
    );
    logCompressionCall({
      event: 'merge:topology-refused',
      operation: `merge_l${targetLevel}`,
      metadata: { ...record },
    }, this.ns);
    // A topology refusal holds no source out of merges (mergeRecordHolds):
    // offer its sources in valid groups without waiting for another L1.
    this.checkMergeThreshold();
  }

  /**
   * Leaf-level ownership audit over the whole summary archive: every summary
   * whose leaves are not contiguous among chunk-owned messages in store
   * order. Read-only; safe to call on any loaded strategy.
   */
  auditStoreTopology(messages: ReadonlyArray<{ id: MessageId }>): TopologyViolation[] {
    this.refreshStoreOrder(messages);
    const position = this.ownershipPositionIndex();
    if (position.size === 0) return [];
    const byPosition: MessageId[] = [];
    for (const [id, p] of position) byPosition[p] = id;
    const byId = new Map(this.summaries.map((s) => [s.id, s] as const));
    const live = this.liveL1Ids();
    const l1Owner = new Map<MessageId, string>();
    for (const s of this.summaries) if (s.level === 1 && live.has(s.id)) for (const id of s.sourceIds) l1Owner.set(id, s.id);
    const leaves = new Map<string, MessageId[]>();
    const collect = (s: SummaryEntry, trail: Set<string>): MessageId[] => {
      const cached = leaves.get(s.id);
      if (cached) return cached;
      if (trail.has(s.id)) return []; // cyclic sourceIds: reported by the pyramid checks, not here
      trail.add(s.id);
      let out: MessageId[];
      // A superseded L1 generation owns nothing (see liveL1Ids).
      if (s.sourceLevel === 0 || s.level === 1) out = live.has(s.id) ? [...s.sourceIds] : [];
      else {
        out = [];
        for (const childId of s.sourceIds) {
          const child = byId.get(childId);
          // One by one: a large child's leaves overflow a spread's argument limit.
          if (child) for (const id of collect(child, trail)) out.push(id);
        }
      }
      trail.delete(s.id);
      leaves.set(s.id, out);
      return out;
    };
    const violations: TopologyViolation[] = [];
    for (const s of this.summaries) {
      const owned = new Set<number>();
      for (const id of collect(s, new Set())) {
        const p = position.get(id);
        if (p !== undefined) owned.add(p);
      }
      if (owned.size < 2) continue;
      let min = Infinity, max = -Infinity;
      for (const p of owned) { if (p < min) min = p; if (p > max) max = p; }
      const holes = max - min + 1 - owned.size;
      if (holes === 0) continue;
      const holeSample: string[] = [];
      const holeOwners = new Set<string>();
      for (let p = min; p <= max && (holeSample.length < 5 || holeOwners.size < 5); p++) {
        if (owned.has(p)) continue;
        const id = byPosition[p];
        if (holeSample.length < 5) holeSample.push(id);
        const owner = l1Owner.get(id);
        if (owner && holeOwners.size < 5) holeOwners.add(owner);
      }
      violations.push({
        id: s.id, level: s.level, leafCount: owned.size,
        span: { first: byPosition[min], last: byPosition[max] },
        holes, holeSample, holeOwners: [...holeOwners],
      });
    }
    return violations;
  }

  /** Violations found by the load-time audit (empty under 'reject', which throws instead). */
  getTopologyViolations(): readonly TopologyViolation[] {
    return this.topologyViolations;
  }

  protected resolvedTopologyPolicy(): 'reject' | 'report' {
    if (this.config.topologyPolicy) return this.config.topologyPolicy;
    const kv = this.config.kvUnified;
    if (kv && (kv.preserveGapBearingSummaries || kv.treeifyNonContiguousSummaries)) return 'report';
    return 'reject';
  }

  /** Load-time gate: audit, then throw (reject) or record + shout (report). */
  protected assertStoreTopology(messages: ReadonlyArray<{ id: MessageId }>): void {
    const violations = this.auditStoreTopology(messages);
    this.topologyViolations = violations;
    if (violations.length === 0) return;
    const policy = this.resolvedTopologyPolicy();
    const detail = violations.slice(0, 20).map((v) =>
      `  L${v.level} ${v.id}: ${v.leafCount} leaves ${v.span.first}..${v.span.last}, ${v.holes} hole(s)` +
      ` e.g. ${v.holeSample.join(',')}${v.holeOwners.length ? ` owned by ${v.holeOwners.join(',')}` : ''}`).join('\n');
    this.diag.error(
      `[store-topology] ⛔ ${violations.length} summar${violations.length === 1 ? 'y owns' : 'ies own'} ` +
        `non-contiguous leaves (policy=${policy}):\n${detail}` +
        (violations.length > 20 ? `\n  … +${violations.length - 20} more` : ''),
    );
    logCompressionCall({
      event: 'store-topology-violation',
      policy,
      count: violations.length,
      violations: violations.slice(0, 50),
    }, this.ns);
    if (policy === 'reject') throw new StoreTopologyError(violations);
  }

  /** Drop persisted queue entries authored under an older grouping grammar.
   * A queue is intent, not memory: if its sources are now parented, missing,
   * out of order, or separated by another live representation, replaying it
   * would mint a crossed node. The threshold pass immediately below rebuilds
   * valid work from the surviving orphan frontier. */
  protected sanitizePersistedMergeQueue(store: MessageStoreView): void {
    if (this.mergeQueue.length === 0) return;
    const position = new Map(store.getAll().map((message, index) => [message.id, index] as const));
    const byId = new Map(this.summaries.map((summary) => [summary.id, summary] as const));
    const valid = (merge: { level: SummaryLevel; sourceIds: string[] }): boolean => {
      if (merge.sourceIds.length < 2) return false;
      let previousEnd: number | null = null;
      for (const sourceId of merge.sourceIds) {
        const source = byId.get(sourceId);
        if (
          !source ||
          source.level !== merge.level - 1 ||
          getSummaryParentId(source)
        ) return false;
        const first = position.get(source.sourceRange.first);
        const last = position.get(source.sourceRange.last);
        if (first === undefined || last === undefined || last < first) return false;
        if (previousEnd !== null && first !== previousEnd + 1) return false;
        previousEnd = last;
      }
      return true;
    };
    const before = this.mergeQueue.length;
    this.mergeQueue = this.mergeQueue.filter(valid);
    if (this.mergeQueue.length === before) return;
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
    this.diag.warn(
      `[autobiographical] discarded ${before - this.mergeQueue.length} stale/non-contiguous ` +
        `persisted merge queue entr${before - this.mergeQueue.length === 1 ? 'y' : 'ies'}; ` +
        `the current grammar will regroup surviving orphans`,
    );
  }

  /**
   * Bounded-retry accounting for a merge whose response was rejected by the
   * terminal-disposition gate. The attempt counter lives ON the persisted
   * queue entry, so restarts don't reset the policy. At the limit, the merge
   * moves from the queue into the durable quarantine — never a retry loop,
   * never silent loss.
   */
  protected recordMergeRejection(
    merge: { level: SummaryLevel; sourceIds: string[]; attempts?: number; lastStopReason?: string; lastOutcome?: string; hadRefusal?: boolean },
    rejection: MergeDispositionRejection,
  ): void {
    this.requireBranchMutation('recordMergeRejection');
    // An answer, or a run decided, ends the entry's run of failures, wherever
    // the entry stands in the queue now.
    this.mergeFailureRuns.delete(mergeFailureKey(merge));
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
    // Synced, like the transient path's run write: a crash must not undo the
    // attempt the policy counts, the run's end, or a quarantine.
    if (merge.attempts >= limit) {
      this.dequeueMerge();
      this.quarantineMerge(merge, rejection, limit);
      this.store?.sync();
      return;
    }
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
    this.store?.sync();
    this.diag.warn(
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
    this.diag.error(
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
    }, this.ns);
    // The record holds its sources out of merges from now on: offer the runs
    // on each side of the hole without waiting for another L1 or merge.
    this.checkMergeThreshold();
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
   * Operator action: lift merge quarantine for one key (or all). A group the
   * record held out of merges is queued again as it stands, in store order (a
   * record an older version wrote can list its sources in another order, and
   * executeMerge takes the order it's given), at the queue's tail with a fresh
   * attempt budget, unless one of its sources is still held
   * (an operator hold, or another record holding it) or already queued:
   * threshold selection alone might not offer it (a group short of the
   * threshold, alone at its level). Then the `checkMergeThreshold` pass
   * offers everything else. The merges formed around the group while it was
   * held stay: it merges into one summary, which stays below its neighbours'
   * level when nothing beside it was left unmerged.
   */
  clearMergeQuarantine(key?: string): void {
    this.requireLoadedBranch('clearMergeQuarantine');
    const cleared = key !== undefined
      ? [this.mergeQuarantine.get(key)].filter((r): r is MergeQuarantineRecord => r !== undefined)
      : [...this.mergeQuarantine.values()];
    if (cleared.length === 0) return;
    const position = this.mergePositionIndex();
    const retry = cleared.filter((record) => this.mergeRecordHolds(record, position));
    for (const record of cleared) this.mergeQuarantine.delete(record.key);
    this.persistMergeQuarantine();
    this.diag.warn(`[merge-quarantine] cleared ${key ? `key=${key.slice(0, 12)}` : 'ALL records'} — merges eligible for re-enqueue`);
    // A group overlapping one already queued, as two records an older version
    // wrote over overlapping groups can, would be skipped as stale once that
    // one merges, with no merge check for its other sources then: the merge
    // check below offers them instead.
    const queued = new Set(this.mergeQueue.flatMap((m) => m.sourceIds));
    for (const record of retry) {
      if (record.sourceIds.some((id) => queued.has(id))) continue;
      // A record that holds is one run in store order (mergeTopologyProblem).
      const [run] = this.contiguousSourceRuns(record.sourceIds.map((id) => this.summaryById(id)!), position);
      const before = this.mergeQueue.length;
      this.enqueueMerge({ level: record.level, sourceIds: run!.map((s) => s.id) });
      if (this.mergeQueue.length > before) for (const id of record.sourceIds) queued.add(id);
    }
    this.checkMergeThreshold();
  }

  /**
   * Sweep merge-quarantine records whose debt no longer exists, so the
   * klaxon only sounds on real debt:
   *  - every source now has a parent (covered by a later successful merge
   *    or repair) → paid, clear;
   *  - only some sources now have parents → the exact quarantined group is
   *    stale and can never be retried without reparenting; clear it so the
   *    remaining orphans can be regrouped;
   *  - no source summary exists anymore (surgery/repair removed them) →
   *    unretryable orphan, clear;
   *  - every source still present and unparented → keep: debt while the
   *    record holds its group (mergeRecordHolds), and otherwise, as for a
   *    topology refusal, kept for the operator to inspect until a source is
   *    parented, the record is cleared, or a topology refusal's group queues
   *    as a valid merge (enqueueMerge).
   */
  protected sweepPaidOffMergeQuarantine(): void {
    if (this.mergeQuarantine.size === 0) return;
    const byId = new Map<string, SummaryEntry>();
    for (const s of this.summaries) byId.set(s.id, s);
    let swept = 0;
    for (const [key, record] of [...this.mergeQuarantine]) {
      if (!mergeRecordStands(record, (id) => byId.get(id))) {
        this.mergeQuarantine.delete(key);
        swept++;
      }
    }
    if (swept > 0) {
      this.persistMergeQuarantine();
      this.diag.warn(`[merge-quarantine] swept ${swept} paid-off/orphaned record(s)`);
      this.checkMergeThreshold();
    }
  }

  /**
   * Repeating klaxon for merge quarantine, mirroring the chunk-quarantine
   * klaxon: it sounds while any record stands, each one an unmerged group to
   * inspect, and counts the records that hold their sources out of merges
   * (mergeRecordHolds), whose sources no summary above spans while merges
   * form around them — debt, not a resting state. Uses the same interval
   * config; `quarantineAlarmIntervalMs: 0` disables.
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
        this.diag.error('[merge-quarantine] ✅ ALL CLEAR — merge quarantine empty; alarm stands down');
      }
      return;
    }
    if (this.mergeQuarantineAlarmActive && now - this.mergeQuarantineAlarmLastAt < interval) return;
    this.mergeQuarantineAlarmActive = true;
    this.mergeQuarantineAlarmLastAt = now;
    const keys = [...this.mergeQuarantine.keys()].map((k) => k.slice(0, 12)).join(',');
    const position = this.mergePositionIndex();
    const holding = [...this.mergeQuarantine.values()].filter((record) => this.mergeRecordHolds(record, position)).length;
    this.diag.error(
      `[merge-quarantine] ⚠️ ${this.mergeQuarantine.size} merge(s) quarantined; ${holding} of them ` +
        `hold their sources out of merges, and no summary above spans those. Operator action ` +
        `required (inspect llm-calls receipts; clearMergeQuarantine retries a held group). keys=${keys}`,
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
   *    range. We gather unmerged L_{n-1} summaries by
   *    `enqueueMergeForRange`'s rule (a source counts when either of its
   *    ends lies in the range; with a range end that has no position, every
   *    source counts), de-duplicated against entries already in
   *    `mergeQueue`, and enqueue a merge over the first `mergeThreshold` of
   *    their longest contiguous run. The merge fires on the next `tick()`.
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
   * compressed or already in the queue. A chunk it adds goes ahead of the
   * chunks that failed or were skipped for their quarantine
   * (orderCompressionQueue).
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
    let pushed = false;
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
      pushed = true;
    }
    // Demanded work goes behind nothing that has failed or been skipped, as
    // every other place that adds to the queue keeps it.
    if (pushed) this.orderCompressionQueue();
  }

  /**
   * Enqueue an L_{targetLevel} merge over unmerged L_{targetLevel-1}
   * summaries whose source ranges reach into [firstMsgId..lastMsgId]: a
   * source counts when either of its ends lies in the range. With a range
   * end neither in the store listing nor owned by a chunk, which has no
   * position, every source counts.
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

    // Position per listed message in store order (see mergePositionIndex),
    // for "within range" and contiguity tests.
    const messageOrder = this.mergePositionIndex();
    const firstSeq = messageOrder.get(firstMsgId);
    const lastSeq = messageOrder.get(lastMsgId);

    const inRange = (msgId: MessageId): boolean => {
      if (firstSeq === undefined || lastSeq === undefined) return true;
      const s = messageOrder.get(msgId);
      if (s === undefined) return false;
      const [lo, hi] = firstSeq <= lastSeq ? [firstSeq, lastSeq] : [lastSeq, firstSeq];
      return s >= lo && s <= hi;
    };

    const held = this.mergeHeldSourceIds(messageOrder);
    const sources: SummaryEntry[] = [];
    for (const s of this.summaries) {
      if (s.level !== sourceLevel) continue;
      if (getSummaryParentId(s)) continue;
      if (queuedAtLevel.has(s.id)) continue;
      if (held.has(s.id)) continue;
      if (!inRange(s.sourceRange.first) && !inRange(s.sourceRange.last)) continue;
      sources.push(s);
    }
    if (sources.length < 2) return;

    // The demand path used to take whatever unmerged sources fell inside the
    // range, holes included (issue #95): a source whose neighbour's L1 had
    // not landed yet was folded across it, minting a crossed node. Group by
    // the same strict-adjacency grammar as the threshold path and take the
    // longest contiguous run; the rest waits for its neighbours.
    const runs = this.contiguousSourceRuns(sources, messageOrder);
    const run = runs.reduce<SummaryEntry[]>((best, r) => (r.length > best.length ? r : best), []);
    if (run.length < 2) {
      this.diag.warn(
        `[autobiographical] demand L${targetLevel} merge over ${sources.length} source(s) in ` +
          `${firstMsgId}..${lastMsgId} has no contiguous pair; nothing enqueued`,
      );
      return;
    }
    if (run.length !== sources.length) {
      const left = sources.filter((s) => !run.includes(s)).map((s) => s.id);
      this.diag.warn(
        `[autobiographical] demand L${targetLevel} merge split by a hole: enqueuing ` +
          `${run.map((s) => s.id).join(',')}; ${left.join(',')} wait for contiguous neighbours`,
      );
    }
    const N = this.config.mergeThreshold ?? 6;
    const toMerge = run.slice(0, N);
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
      // The pause binds the membrane instance and model of the call that
      // failed. Readiness has no context to name the membrane, so a pause
      // bound to another instance shows until the next tick drops it; one
      // bound to another model doesn't show. It names what failed last and
      // its class: how long compression has been behind is
      // getCompressionDebt's oldest pending age.
      const pause = this.compressionPause &&
        this.compressionPause.model === this.config.compressionModel &&
        Date.now() < pauseUntil(this.compressionPause)
        ? this.compressionPause
        : null;
      const paused = pause
        ? `; compression paused ${pauseUntilText(pause)} ` +
          `(${pauseSourceText(pause)}, failure ${pause.failures}` +
          `${pause.latest ? `; latest: ${pause.latest.subject} failed (${pause.latest.failureClass})` : ''})`
        : '';
      return {
        ready: false,
        description: `${parts.join(' + ')} pending${paused}`,
      };
    }

    return { ready: true };
  }

  async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
    this.requireLoadedBranch('onNewMessage');
    this.rebuildChunks(ctx.messageStore);

    // Auto-tick: fire speculative compression in the background. After
    // each tick completes, if the queue still has work AND preflight
    // allows, schedule another tick; tick itself skips L1 compression
    // while the speculation cap holds it (speculativeCapHolds).
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
   * subject to the preflight hook, and to the speculation cap through tick's
   * L1 step (speculativeCapHolds). Each next tick runs from a timer
   * (`setTimeout` 0), so one chunk's compression doesn't block the
   * scheduling of the next. No caller awaits that tick, so nothing it throws
   * leaves the timer: a tick that comes due on a closed store doesn't run,
   * and what a tick throws is logged, unless it is a host's withdrawal or
   * cancellation (compressionFailureKind's 'abort'), which ends the drain
   * quietly. A tick already running when the store closes ends in the
   * drain's own `.catch`, which does the same.
   *
   * Stops if a tick fails to make progress (no queue item consumed, by
   * `_drainProgress`) — guards against runaway recursion when tick is a
   * no-op (e.g. no membrane configured, or a subclass override that doesn't
   * process the queue).
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
    // Only bail when the *sole* available work is L1 compression that the
    // preflight currently forbids. Merge work always proceeds. Here no merge
    // is queued, or `hierarchical` is off, and the cap holds nothing either
    // way (speculativeCapHolds), so it can't be what stops the drain. With a
    // merge queued and `hierarchical` on, tick's L1 step comes first and takes
    // a chunk unless the queue is empty or the cap holds, and the merge runs
    // otherwise.
    if (!hasMerges && !this.shouldCompressPreflight()) return;

    const progressBefore = this._drainProgress;
    const drainIdentity = this.loadedBranchIdentity;

    this.tick(ctx)
      .then(() => {
        // Progress = the tick actually processed a queue item (compress or
        // merge), tracked by `_drainProgress`. A queue-length delta is the
        // wrong signal: a productive merge tick can also enqueue a follow-on
        // merge, leaving the length unchanged — which the old check misread as
        // "no progress" and halted the drain mid-backlog. A genuine no-op tick
        // (empty queues, the cap holding production while a hold blocks the
        // head merge, no membrane) doesn't advance the counter, so this still
        // stops cleanly (no runaway recursion).
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
        // The next tick runs only under the loaded identity this drain
        // started with: once the strategy is detached or reinitialized, or
        // the store's branch moved, the drain stops here quietly, rather than
        // run a tick that requireLoadedBranch() refuses and the catch below
        // logs. A strategy set again starts its own drain from its next
        // message.
        setTimeout(() => {
          // No caller awaits this tick, so nothing it throws may leave the
          // timer: an uncaught exception ends the host's process. A tick that
          // comes due on a store the host has closed, as its stop() closes
          // one, doesn't run, and the drain ends quietly, as on a withdrawal.
          // What the tick throws is logged, as below, unless it is a host's
          // withdrawal or cancellation.
          try {
            if (this.store?.isClosed()) return;
            if (this.loadedBranchIdentity !== drainIdentity || !this.isLoadedBranchCurrent()) return;
            this.driveSpeculativeDrain(ctx);
          } catch (err) {
            this.diag.error(`AutobiographicalStrategy: speculative-drain error: ${describeCompressionFailure(err)}`);
          }
        }, 0);
      })
      .catch((err) => {
        // A host's withdrawal, or its cancellation of a call, stops the drain
        // quietly: the host asked for it.
        if (compressionFailureKind(err) === 'abort') return;
        this.diag.error(`AutobiographicalStrategy: speculative-drain error: ${describeCompressionFailure(err)}`);
      });
  }

  /**
   * Whether the count of *produced, unmerged* L1 summaries is past the cap
   * configured by `maxSpeculativeL1s`: more of them than it allows. If no cap
   * is set, always false.
   *
   * The cap bounds how many L1 summaries may sit un-consolidated before the
   * strategy must merge them into L_{k+1} (bounding prefix churn / merge debt).
   * It deliberately does NOT count the pending `compressionQueue`: that queue is
   * the backlog of work to be *drained*, not produced summaries. Counting it
   * here would let a large backlog permanently trip the cap and block the very
   * compression that would clear it — a deadlock (merges relieve the cap, but
   * compression of the backlog never resumes). The throttle is on produced L1s.
   * Being past the cap holds production only while an L1 merge is queued to
   * bring the count back down (speculativeCapHolds).
   */
  protected isAtSpeculativeCap(): boolean {
    const cap = this.config.maxSpeculativeL1s;
    if (cap === undefined || cap < 0) return false;
    const unmergedL1s = this.summaries.filter(s => s.level === 1 && !s.mergedInto).length;
    return unmergedL1s > cap;
  }

  /**
   * Whether the speculative cap holds L1 production now: past the cap, while
   * an L1→L2 merge is queued and `hierarchical` is on, so that tick will run
   * it and bring the count of unmerged L1s back down (or drop it as stale,
   * as when a merge-quarantine record holds one of its sources). Production waits for
   * that merge however long the merge waits: behind another merge at the
   * head, on a hold over its sources, or through calls that fail and retry.
   *
   * With no L1 merge queued, no merge the cap could wait for is coming, so it
   * holds nothing (issue #240). Threshold selection forms no merge below
   * `mergeThreshold` unmerged L1s, which a cap below `mergeThreshold - 1`
   * stopped short of.
   * L1s that can't merge count toward the cap: a pruned source, the wide-span
   * quarantine, a lone interior summary, or a held one (mergeHeldSourceIds: an
   * operator hold, or a group a merge-quarantine record holds out of merges).
   * And under `hierarchical: false` tick runs no merge, though
   * checkMergeThreshold can still queue one.
   */
  protected speculativeCapHolds(): boolean {
    if (!this.isAtSpeculativeCap()) return false;
    // Read `hierarchical` as tick's merge step reads it: this predicts that step.
    return Boolean(this.config.hierarchical) && this.mergeQueue.some((m) => m.level === 2);
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
    // Detached, or the branch moved, during the sweep: nothing more to do.
    if (!this.isCompressionBranchCurrent(sourceBranch)) return;
    this.sweepCompressionProgressIfDue(ctx);
    this.soundMergeQuarantineAlarmIfNeeded();
    if (this.pendingCompression) return;

    if (!ctx.membrane) {
      this.diag.warn('AutobiographicalStrategy: No membrane instance for compression');
      return;
    }

    // A transient provider failure paused the lane: no compression call and
    // no queue item consumed until the pause ends (see pauseCompressionLane).
    if (this.activeCompressionPause(ctx)) return;

    // Priority 1: Compress raw chunks → L1. Skipped while the speculative cap
    // (maxSpeculativeL1s) holds production, so we don't pile up more unmerged
    // L1s: past the cap with an L1 merge queued, which the merge priority below
    // runs to consolidate existing L1s and relieve the cap (speculativeCapHolds).
    // No cap configured → it never holds → unchanged.
    // A durable quarantine skip is not attempted compression. Bound this
    // scan by the distinct source identities initially queued, not by shifts:
    // an inbound rebuild during a yield can reinsert an already-skipped head
    // and replace every chunk object/index (issue #55, PR #138 review).
    const candidates = new Set<string>();
    this.compressionQueue = this.compressionQueue.filter((index) => {
      const chunk = this.chunks[index];
      if (!chunk || chunk.compressed) {
        this._drainProgress++; // stale queue cleanup
        return false;
      }
      candidates.add(this.chunkKey(chunk));
      return true;
    });
    for (const key of candidates) {
      if (this.speculativeCapHolds()) break;
      // Resolve against the current queue: a rebuild may renumber chunks or
      // withdraw one (e.g. holdback). Never resurrect withdrawn work or use a
      // stale chunk object. Newly queued source identities wait for next tick.
      const queueIndex = this.compressionQueue.findIndex((index) => {
        const chunk = this.chunks[index];
        return chunk !== undefined && this.chunkKey(chunk) === key;
      });
      if (queueIndex < 0) continue;
      // A chunk whose split-stitch rung waits for its call window stays
      // queued and lets the work behind it run.
      const notBefore = this.compressionNotBefore.get(key);
      if (notBefore !== undefined) {
        if (Date.now() < notBefore) continue;
        this.compressionNotBefore.delete(key);
      }
      // A chunk that failed gives its turn to a merge that hasn't failed since.
      const failedAt = this.compressionFailureOrder.get(key);
      if (failedAt !== undefined && this.mergeTakesTurnBefore(failedAt, ctx.messageStore)) break;
      const [chunkIndex] = this.compressionQueue.splice(queueIndex, 1);
      const queueGeneration = this.compressionQueueGeneration;
      this._drainProgress++; // consumed a queue item (real work or stale-cleanup)
      const chunk = this.chunks[chunkIndex];

      if (!chunk || chunk.compressed) continue;
      // A chunk that closed before a hold was placed (holdCompression after
      // the fact) waits; the rebuild after release re-queues it. As on main,
      // a held chunk ends this tick's scan.
      if (this.chunkHasHeldMessage(chunk, this.holdBlockedIds(ctx.messageStore))) return;

      let quarantineSkipped = false;
      let requestStopped = false;
      let joinedWorkDiscarded = false;
      const work: { chunk: Chunk; skipped?: true } = { chunk };
      this.pendingCompressionWork = work;
      const compression = this.compressChunkHierarchical(chunk, ctx, () => {
        quarantineSkipped = true;
        // No model call follows: from here the work in flight stops
        // counting (compressionWorkQueued), through the hop below too.
        work.skipped = true;
      }, () => {
        requestStopped = true;
      }, () => {
        joinedWorkDiscarded = true;
      }).then(async () => {
        // Quarantine checks build compression contexts too. As in the
        // speculative drain, a macrotask hop keeps those builds from starving
        // inbound events. Keep the hop inside pendingCompression so another
        // tick cannot start auxiliary work while this scan yields.
        if (quarantineSkipped) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      this.pendingCompression = compression;

      try {
        await compression;
      } catch (error) {
        // A failure that did not decide the chunk (transient, a deferral by
        // the caller's provider admission, or an abort) leaves its work
        // pending. Put it back, so the lane finds it once the pause ends
        // without waiting for a new message or a restart: behind the work
        // that hasn't failed after a failure, and after a deferral or an
        // abort where it was (the head, unless it failed before). A rebuild
        // during the call has already re-decided the chunk's eligibility: it
        // is put back only where that rebuild queued it, and a withdrawal
        // stands. A chunk compressed meanwhile is never put back.
        const kind = compressionFailureKind(error);
        if (this.isCompressionBranchCurrent(sourceBranch) && kind !== 'rejection') {
          // Only this instance's own window holds the chunk: a wait that
          // another instance's split rung met, rethrown to this one through a
          // joined call, says nothing about this instance's window.
          if (error instanceof CompressionSplitWindowWait && error.window === this.splitWindow) {
            this.compressionNotBefore.set(key, Date.now() + error.waitMs);
          }
          this.requeuePendingChunk(
            key,
            kind === 'transient' && !isNoCallDeferral(error) ? 'back' : 'head',
            this.compressionQueueGeneration !== queueGeneration,
          );
        }
        // Merge discovery runs after a thrown attempt too, as after a return:
        // a rung's answer, fresh or reused, ends its run inside the ladder, and
        // a later call can still throw (a transient failure, a withdrawal), so
        // the merges that run held are found here. A failure of its own is
        // logged, and the attempt's error stays the one acted on: tick's
        // callers act on it (a host may count a withdrawal as no failure), a
        // window wait goes on with the scan below, and a merge discovery queued
        // is in memory before the write that failed.
        if (this.isCompressionBranchCurrent(sourceBranch)) {
          try {
            this.checkMergeThreshold();
          } catch (discoveryError) {
            this.diag.warn(`[autobiographical] merge discovery after a failed compression attempt failed (the attempt's error stands): ${describeCompressionFailure(discoveryError)}`);
          }
        }
        // A split-stitch window wait, this instance's own or one a joined call
        // rethrew: nothing failed here and no call was made, so the scan goes
        // on to the work behind it, unless the branch switched meanwhile. The
        // chunk waits out the window only when the window is its own (above);
        // a joined call's wait puts it back at the head, unheld.
        if (error instanceof CompressionSplitWindowWait) {
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          continue;
        }
        throw error;
      } finally {
        // A branch switch may have installed different pending work.
        if (this.pendingCompression === compression) {
          this.pendingCompression = null;
          this.pendingCompressionWork = null;
        }
      }
      if (!this.isCompressionBranchCurrent(sourceBranch)) return;
      if (joinedWorkDiscarded) {
        // The work this compression joined was thrown away, its strategy let
        // go of, and nothing here asked the provider. The chunk goes back at
        // the head, unless a rebuild during the wait re-decided it, and the
        // scan goes on to the work behind it, as after a joined call's split
        // window wait: the next scan starts the chunk through the gates above.
        this.requeuePendingChunk(key, 'head', this.compressionQueueGeneration !== queueGeneration);
        continue;
      }
      if (quarantineSkipped) {
        // Skipped: quarantined, still raw, and queued again at every rebuild
        // (every inbound message). It takes a failure order, as a failed
        // chunk does, so the queue keeps it behind the chunks that haven't
        // failed, and tick builds their requests before it builds this one's
        // only to find its quarantine again. A rebuild during the yield above
        // may have queued it before it had that order, so the queue is sorted
        // now. Its runs end (endChunkFailureRuns): this request won't be
        // retried, so the merges beside its span stop waiting for it.
        if (this.endChunkFailureRuns(key)) this.checkMergeThreshold();
        this.compressionFailureOrder.set(key, ++this.compressionFailureSequence);
        this.orderCompressionQueue();
      } else {
        // Returned without a failure: decided (landed, exhausted, held by
        // another process's record, or its family dropped while its ladder
        // ran), or no call was made. No longer failing. A dropped family's
        // recorded outcomes go with it, so the next attempt pays for its
        // ladder afresh: a clear asks for one, a mint leaves the span nothing
        // to do, and a sweep drops only progress nothing advanced for 30 days,
        // progress a summary already paid off, and progress whose span can't
        // be cut again (a message of it is gone from the store, or an entry
        // older releases wrote carries no ids and no chunk record matches it).
        // The chunk's runs are not the family's: they count failures of the
        // chunk's rungs on their route, so they carry into that attempt with
        // their counts.
        // The chunk's runs end where this process won't retry its request
        // (endChunkFailureRuns): the chunk compressed (a mint, an adoption,
        // the dedup guard, a thin stub, or the L1 of a call it joined), which
        // marks this chunk object even where a rebuild during the call cut
        // another in its place, with the same key, since a key is a chunk's
        // sources; or its request was found or made unable to go
        // (onRequestStopped: an exhaustion whose record the ledger holds, a
        // joined call whose family the ledger holds, the overlap guard while
        // the overlap stands). Otherwise they stand, since a retry is coming:
        // tools not yet pushed, a family dropped meanwhile, or a hold placed
        // during a joined call, which discarded another instance's answer (the
        // chunk is asked for again once the hold is released). This ladder's
        // own answer ends its rung's run when it comes (runAttempt, or the
        // complete stitch), before a hold can discard it, so no run stands for
        // that hold. Merge discovery runs after every such return, as after a
        // thrown attempt, since a run may have ended here or inside the
        // ladder, where a rung's answer, fresh or reused, ends its run.
        if (chunk.compressed || requestStopped) this.endChunkFailureRuns(key);
        this.compressionFailureOrder.delete(key);
        this.checkMergeThreshold();
      }
      // Attempts, including fresh refusals, still consume the tick. Existing
      // overrides that omit the optional notification keep that behavior.
      if (!quarantineSkipped) return;
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
      // A late hold (placed on a message some L1 already covers) pauses
      // merges reaching it: the merge prompt replays raw sources. No progress
      // is recorded, so the drain stops; release resumes it.
      if (this.mergeBlockedByHold(merge.sourceIds, ctx.messageStore)) return;
      this._drainProgress++; // executing a merge is real work, even if a
      // follow-on merge gets enqueued and the queue length nets out unchanged
      // Whether the merge wrote its parent (see executeMerge): a skipped
      // entry wrote nothing.
      let merged = false;
      // executeMerge builds its request before its first await, so this is
      // the model the call names.
      const mergeModel = this.config.compressionModel;
      const mergeMembrane = ctx.membrane;
      this.pendingCompressionWork = { sourceIds: [...merge.sourceIds] };
      const merging = this.executeMerge(merge.level, merge.sourceIds, ctx).then((wrote) => {
        merged = wrote;
      });
      this.pendingCompression = merging;

      try {
        await merging;
        if (!this.isCompressionBranchCurrent(sourceBranch)) {
          // A merge written before the branch switched still landed on its
          // route: the domain's count is the route's.
          if (merged) noteDomainLanding(mergeMembrane, mergeModel);
          return;
        }
        // Success, or a skipped entry: drop from head and persist the
        // shorter queue, if the head is still our merge. executeMerge drops
        // the head itself when it refuses a crossed merge or skips an entry
        // holding a held source, and a merge that took up another instance's
        // state (parentedMergeSources) has replaced the queue with the
        // store's while it ran: dequeuing again would drop the next entry.
        if (this.mergeQueue[0] === merge) {
          this.dequeueMerge();
        }
        this.mergeFailureOrder.delete(mergeFailureKey(merge));
        // Only a written merge is a landing. A skip before the call (a stale
        // entry, a missing source, a crossed merge refused) made no call, so
        // it is neither a landing nor an answer: counting it would let an
        // outage advance a domain's evidence, and resuming would reset the
        // lane's backoff. A merge whose sources were parented while its call
        // was out got an answer, which executeMerge has already counted by
        // resuming the lane, and wrote nothing, so it is no landing either.
        if (merged) {
          this.resumeCompressionLane(mergeMembrane, mergeModel);
          // The merge's summary is written and its entry dequeued: it has landed.
          this.noteCompressionLanded(mergeMembrane, mergeModel);
        }
      } catch (error) {
        // Withdrawn by the host, or its call cancelled by the host: no
        // attempt, no streak; the merge stays at the head of the queue for
        // the next tick.
        if (compressionFailureKind(error) === 'abort') throw error;
        // Terminal-disposition rejection: the LLM answered, but with a
        // refusal / truncation / tool call / empty — bounded-retry policy,
        // not a crash. Anything else (429, network, timeout) keeps the
        // pre-existing semantics: rethrow, entry stays queued, next tick
        // retries with no attempt accounting.
        if (error instanceof MergeHoldDiscard) {
          // The provider answered, but a hold placed on the span during the
          // call keeps the answer out. Nothing failed: no pause, nothing
          // counted. The entry stays queued (the next tick waits on the
          // hold), and its run ends, since its request answered.
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          this.mergeFailureOrder.delete(mergeFailureKey(merge));
          this.mergeFailureRuns.delete(mergeFailureKey(merge));
          return;
        }
        if (error instanceof MergeDispositionRejection) {
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          this.mergeFailureOrder.delete(mergeFailureKey(merge));
          this.recordMergeRejection(merge, error);
          return;
        }
        // A request-attributable rejection (compressionFailureKind's
        // 'rejection': the membrane's errorType is context_length,
        // invalid_request, safety or unsupported) is deterministic: the
        // identical request fails identically on every tick, and the rethrow
        // path below has no attempt accounting — a hot retry loop (opus4
        // 2026-08-03: 442 context_length 400s at ~6s intervals, 2.7GB of
        // full-payload error logs). Route it through the same bounded
        // attempts/quarantine policy as disposition rejections; the merge
        // prompt halves its recall budget per attempt (see executeMerge),
        // so each retry is a genuinely smaller request. The rule keys on the
        // errorType, not on the membrane's retryable flag: everything else
        // (429, network, timeout, credentials, quota) pauses the lane.
        const membraneType = (error as { type?: unknown; retryable?: unknown }) ?? {};
        const failureKind = compressionFailureKind(error);
        // Only a request-attributable rejection is evidence about this merge
        // request. A non-retryable failure that is not (spent quota,
        // credentials) pauses the lane like any transient one below.
        if (failureKind === 'rejection' && typeof membraneType.type === 'string') {
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          this.mergeFailureOrder.delete(mergeFailureKey(merge));
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
        // Any other failure (a server error, a timeout, a spent quota, an
        // untyped throw) says nothing about this merge by its kind: the lane
        // pauses, and the merge goes behind the others queued, so they run.
        // It is evidence about the merge only by the company it keeps
        // (nextFailureStreak): a persistent fault on one payload (rhys
        // 2026-08-06: 514 consecutive merge 500s across a week-long episode)
        // fails while other compression lands on its route and model, and at
        // COMPRESSION_PERSISTENT_FAILURES it goes through the
        // bounded rejection policy, whose retries shrink the recall budget,
        // giving the provider a genuinely different request. In an outage
        // nothing lands, so nothing is counted. A deferral by the caller's
        // provider admission made no call: it counts nothing and adds no
        // backoff, and the lane waits only on the admission's recheck
        // (pauseCompressionLane). As in L1's
        // interrupt, the run is decided before any pause: the failure that
        // decides it is the merge's own, not the lane's, so it pauses nothing.
        if (failureKind === 'transient') {
          if (!isAdmissionDeferral(error) && this.isCompressionBranchCurrent(sourceBranch)) {
            const failureClass = compressionFailureClass(error);
            const dispatched = (error !== null && typeof error === 'object' ? dispatchedCompressionModel.get(error) : undefined) ?? mergeModel;
            const streak = nextFailureStreak(
              this.mergeFailureRuns.get(mergeFailureKey(merge)),
              sha256Json({ level: merge.level, sourceIds: merge.sourceIds }),
              compressionDomain(ctx.membrane, dispatched),
              domainLanded(ctx.membrane, dispatched),
            );
            if (streak.failures >= AutobiographicalStrategy.COMPRESSION_PERSISTENT_FAILURES) {
              this.mergeFailureOrder.delete(mergeFailureKey(merge));
              this.recordMergeRejection(
                merge,
                new MergeDispositionRejection(
                  merge.level,
                  'provider_error',
                  sha256Json({ level: merge.level, sourceIds: merge.sourceIds, transport: `persistent-${failureClass}` }),
                  undefined,
                  `persistent-${failureClass}`,
                ),
              );
              return;
            }
            this.mergeFailureRuns.set(mergeFailureKey(merge), streak);
            this.mergeFailureOrder.set(mergeFailureKey(merge), ++this.compressionFailureSequence);
            if (this.mergeQueue[0] === merge && this.mergeQueue.length > 1) {
              this.mergeQueue.shift();
              this.mergeQueue.push(merge);
            }
          }
          this.pauseCompressionLane(
            sourceBranch, ctx, error, 'merge',
            `the L${merge.level} merge of ${merge.sourceIds.length} summaries from ${merge.sourceIds[0] ?? '?'}`,
          );
        }
        throw error;
      } finally {
        // As for L1 above: a branch switch may have installed different
        // pending work, whose ownership this stale merge must not release.
        if (this.pendingCompression === merging) {
          this.pendingCompression = null;
          this.pendingCompressionWork = null;
        }
      }
    }
  }

  /**
   * The ids of `sources` a merge may no longer parent: each this instance
   * holds as parented, or the store's summary list does. A parent only the
   * store holds means the store has changed since this instance loaded, as
   * another instance's merge changes it: this instance then takes up the
   * store's state, as a compression that waited on another instance's does,
   * so that afterwards its threshold pass and its count of unmerged
   * summaries see that merge rather than choosing the run again.
   */
  private parentedMergeSources(sources: readonly SummaryEntry[]): string[] {
    const parented = new Set(sources.filter((source) => getSummaryParentId(source)).map((source) => source.id));
    const held = parented.size;
    const stored = this.store?.getStateJson(this.summariesStateId);
    if (Array.isArray(stored)) {
      const ids = new Set(sources.map((source) => source.id));
      for (const item of stored as Array<SummaryEntry | null>) {
        if (!item || typeof item.id !== 'string' || !ids.has(item.id)) continue;
        const parent = getSummaryParentId(item);
        if (typeof parent === 'string' && parent) parented.add(item.id);
      }
    }
    if (parented.size > held) this.takeUpStoreState();
    return [...parented];
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
    // Only stats this select records are its own: on a throw before they're
    // written, an earlier select's must not pose as this one's.
    this._lastSelectStats = null;
    this.requireLoadedBranch('select');
    this._selectStartedAt = performance.now();
    this._selectMessages = store.length();
    const lastRenderStats = this._lastRenderStats;
    const _diag = typeof process !== 'undefined' && !!process.env?.CM_CACHE_DIAG;
    const _t0 = _diag ? Date.now() : 0;
    if (opts?.dryRun !== true) {
      this.rebuildChunks(store);
      if (_diag) this.diag.error(`[cm-cache] select: rebuildChunks ${Date.now() - _t0}ms`);
      // The cache-marker baseline is the last request this strategy returned.
      // A select refused after it placed its markers (assertMiddleCoverage,
      // kv-unified's marker reconcile) returns none, so its keys go back, and
      // the next compile's stable prefix and fold diff are measured against
      // the request before it.
      const prevCacheKeys = this._prevCacheKeys;
      this.thinkingBound = opts?.thinkingBinding?.binds === true;
      try {
        return this.withToolPruning(store, () => this.selectPath(store, budget, opts));
      } catch (err) {
        this._prevCacheKeys = prevCacheKeys;
        throw err;
      } finally {
        this.thinkingBound = false;
        if (this._lastRenderStats !== lastRenderStats) this._lastSelectStats = this._lastRenderStats;
      }
    }
    // A dry run commits nothing, and that includes what a select leaves for
    // the next one and for observers: the cache-marker baseline the next
    // compile measures its stable prefix against, the transition status
    // (getHotContextSettings), the render stats (getRenderStats, with its
    // plan-vs-actual), calibration's estimate, arming, store view, load and
    // multiplier, with the multiplier the store prices by (a dry select that
    // loads the multiplier first leaves it unloaded, so the next committing
    // select loads it again and persists what the load decides), the store
    // order with the listing it was built from, and the head-window memo stay
    // as the last committing select left them. The order and its listing go
    // back together: an order put back beside the dry run's listing would
    // read as current for that listing, so after a removal later selects
    // would position messages as they stood before it until something
    // rebuilt the order. A dry refresh extends a copy of the order rather
    // than the one saved here (refreshStoreOrder). They are put back
    // here, on every path out, throws included; each select path gates its
    // own persistence and enqueueing. The dry run's own
    // render stats are its output, as its plan is (_lastPreview): they stay
    // in _lastSelectStats, which previewContext and a compile read.
    // Chunking runs dry too: a chunk the dry run closes gets no record, and
    // the chunks, the compression queue and whether chunk records are trusted
    // (a dry rebuild at a preview's chunk size can read them as orphaned) go
    // back to the last committing rebuild's, so no tick compresses what only
    // a dry run (or a preview's overridden chunk size) cut. So does the
    // queue's generation: a call in flight must not read the dry rebuild as
    // one that re-queued its chunk (requeuePendingChunk).
    const restore = this.saveDryRunState(store);
    this._dryRunSelect = true;
    this.thinkingBound = opts?.thinkingBinding?.binds === true;
    try {
      this.rebuildChunks(store);
      if (_diag) this.diag.error(`[cm-cache] select: rebuildChunks ${Date.now() - _t0}ms`);
      return this.withToolPruning(store, () => this.selectPath(store, budget, opts));
    } finally {
      this._dryRunSelect = false;
      if (this._lastRenderStats !== lastRenderStats) this._lastSelectStats = this._lastRenderStats;
      restore();
      this.thinkingBound = false;
    }
  }

  private selectPath(store: MessageStoreView, budget: TokenBudget, opts?: SelectOptions): ContextEntry[] {
    // Image stripping runs inside each select path (before stats commit / cache
    // markers), so the returned entries are already bounded — see
    // applyImageStripping.
    if (this.config.adaptiveResolution) {
      try {
        return this.selectAdaptive(store, budget, opts);
      } catch (err) {
        // A provisional multiplier above 1 that puts the compile over budget
        // is dropped to 1 and the select runs again: with the refusal
        // standing, no inference would run, so no sample could ever correct
        // it (#179, the startup wedge). Any other refusal stands.
        if (!(err instanceof OverBudgetError) || !this.dropProvisionalCalibration(err, opts?.dryRun === true)) throw err;
        // The retry answers for the select: a preview the discarded attempt
        // recorded mustn't stand in for a retry that refuses before recording
        // its own (previewContext reads _lastPreview).
        this._lastPreview = undefined;
        return this.selectAdaptive(store, budget, opts);
      }
    }
    // selectHierarchical persists and enqueues nothing; what it leaves for
    // observers (render stats) select() restores for a dry run.
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

  /** The failure getCompressionDebt() last logged on this load, so one that lasts across polls logs once. */
  private compressionDebtFailureLogged: string | null = null;

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
   *                recovering on its own; an operator is needed. Also while
   *                the load-time audit found crossed ownership, or a merge
   *                group stands in the merge quarantine because merging it
   *                would have minted a crossed node (`topologyRefusals`).
   * - `unknown`  — the report couldn't read what decides its state.
   *
   * A report that couldn't read something says in `error` what happened,
   * what it means and what to do, for the operator who reads it: a line
   * saying what happened, then `Cause:`, `Effect:` and `Fix:` lines.
   * `failure` names which read failed, and each count it couldn't compute is
   * `null`, never 0.
   *
   * When only the compression quarantine ledger can't be read (`failure`
   * `quarantine-ledger`), `compressionQuarantineCount` is `null` and the rest
   * is reported. The state is then worked out twice, as if the ledger held no
   * record and as if it held one, since the rules only ask whether there is
   * any quarantine. Where both give the same state, that is the state, and
   * where they differ it is `unknown`. So crossed ownership still reads
   * `critical`, and a chunk that has waited between 1h and 6h still reads
   * `degraded`. Compression of new conversation stalls then too: each
   * attempt that would call the model reads the ledger first, and stops
   * there with the same words.
   *
   * When anything else fails (`failure` `report`), the state is `unknown` and
   * every count is `null`. Outside the ledger the report reads only the
   * strategy's own state and the options it was given, so that's a fault in
   * context-manager or in those options, and compression itself may be
   * running normally.
   *
   * `oldestPendingAgeMs` and `lastMintAt` are also `null` when nothing is
   * pending or nothing has been minted; in a report that failed outright,
   * `state` is `unknown` and they mean nothing. A failure is logged once
   * through the strategy's diagnostics, its lines joined into one: when a
   * report first fails, and again only after a report succeeds or the
   * failure's text changes. The first report that reads again after a
   * failure logs that it does. Each load starts afresh, as a restart does:
   * it logs a failure it meets, and no recovery from a failure that only an
   * earlier load met.
   *
   * The OPEN frontier chunk (still accumulating messages) is not debt and
   * is excluded. Ages derive from the newest message inside the oldest
   * pending chunk — chunk records carry no timestamps of their own.
   * It changes nothing but its note of the failure it last logged and what
   * its read of the ledger names once per load, with that read's warn line,
   * and it never throws (health surface contract).
   */
  getCompressionDebt(now: number = Date.now()): {
    state: 'healthy' | 'degraded' | 'critical' | 'unknown';
    /**
     * What happened, what it means and what to do, for an operator: a line saying what
     * happened, then `Cause:`, `Effect:` and `Fix:` lines. Present whenever a count
     * below is `null` for that reason.
     */
    error?: string;
    /** Which read failed, whenever `error` is present: the compression quarantine ledger, which compression needs, or the report itself. */
    failure?: 'quarantine-ledger' | 'report';
    pendingChunks: number | null;
    oldestPendingAgeMs: number | null;
    mergeQueueDepth: number | null;
    mergeQueueMaxAttempts: number | null;
    mergeQuarantineCount: number | null;
    /** Keys of quarantined merges (sha256 of their source ids). */
    mergeQuarantineKeys: string[] | null;
    /** Operator holds (`mergeHoldSummaryIds`): deliberate, so they don't change `state`,
     *  but they constrain the scheduler and must be visible when the frontier grows. */
    mergeHeldIds: string[] | null;
    compressionQuarantineCount: number | null;
    unmergedFrontier: { l1: number; l2: number; l3: number } | null;
    lastMintAt: number | null;
    /** Summaries with crossed ownership found by the load-time audit (topologyPolicy 'report'). */
    topologyViolations: number | null;
    /** Merge groups standing in the merge quarantine because merging them would have minted
     *  a crossed node: records whose every source is still present and unparented. Each holds
     *  `critical` until an operator clears it, its group queues as a valid merge, or a source
     *  is parented or gone, which the sweep then removes. */
    topologyRefusals: number | null;
  } {
    const DEGRADED_AFTER_MS = 60 * 60 * 1000;
    const CRITICAL_AFTER_MS = 6 * 60 * 60 * 1000;
    try {
      // Exclude the trailing open chunk: it is life, not debt.
      const closed = this.chunks.filter((c, i) => !(i === this.chunks.length - 1 && !c.compressed));
      const pending = closed.filter((c) => !c.compressed);
      // Chronicle timestamps may be µs; normalize to ms defensively.
      const toMs = (t: number): number => (t > 1e14 ? t / 1000 : t);
      let oldestPendingAgeMs: number | null = null;
      for (const c of pending) {
        // Live StoredMessage carries `timestamp: Date`; the serialized form
        // carries a number. The original number-only filter silently dropped
        // EVERY in-memory message, so oldestPendingAgeMs was null whenever
        // chunks held Date timestamps — the staleness detector (degraded>1h,
        // critical>6h) was dead code in production and `healthy` was
        // unearned (production signature 2026-08-29: pendingChunks>0,
        // age=null, state=healthy). chunkClosedAtMs accepts both shapes.
        const closedAt = chunkClosedAtMs(c.messages);
        if (closedAt === undefined) continue;
        const age = now - closedAt;
        if (oldestPendingAgeMs === null || age > oldestPendingAgeMs) oldestPendingAgeMs = age;
      }
      const mergeQuarantineCount = this.mergeQuarantine.size;
      const ledger = this.compressionQuarantineRecordCount();
      // A refusal counts while its group stands as it was refused, by the
      // sweep's own test, so a group paid off since counts no refusal, and
      // its refusal no longer makes the report critical, before a sweep runs:
      // in an audit, which never ticks, and between ticks. Its record still counts as a
      // quarantine until the sweep removes it, as every record does.
      let topologyRefusals = 0;
      for (const record of this.mergeQuarantine.values()) {
        if (record.lastOutcome === 'topology_violation' && mergeRecordStands(record, (id) => this.summaryById(id))) topologyRefusals++;
      }
      const mints = this.summaries
        .map((s) => s.created)
        .filter((t): t is number => typeof t === 'number');
      // Folded, not spread: Math.max(...array) overflows the call stack past
      // about 125,000 entries.
      const lastMintAt = mints.length ? toMs(mints.reduce((max, t) => Math.max(max, t))) : null;

      const stateWith = (compressionQuarantines: number): 'healthy' | 'degraded' | 'critical' => {
        // Crossed ownership is never a matter of waiting: it is critical until
        // an operator repairs the store, or while a refused group's record stands.
        if (this.topologyViolations.length > 0 || topologyRefusals > 0) return 'critical';
        const quarantines = mergeQuarantineCount + compressionQuarantines;
        if (
          oldestPendingAgeMs !== null &&
          oldestPendingAgeMs > CRITICAL_AFTER_MS &&
          (quarantines > 0 || pending.length >= 5)
        ) {
          return 'critical';
        }
        const stale = oldestPendingAgeMs !== null && oldestPendingAgeMs > DEGRADED_AFTER_MS;
        return quarantines > 0 || stale ? 'degraded' : 'healthy';
      };
      let state: 'healthy' | 'degraded' | 'critical' | 'unknown';
      let error: string | undefined;
      if ('count' in ledger) {
        state = stateWith(ledger.count);
      } else {
        error = compressionQuarantineUnreadableMessage(ledger.error);
        const withNone = stateWith(0);
        state = withNone === stateWith(1) ? withNone : 'unknown';
      }
      const report = {
        state,
        ...(error !== undefined ? { error, failure: 'quarantine-ledger' as const } : {}),
        pendingChunks: pending.length,
        oldestPendingAgeMs,
        mergeQueueDepth: this.mergeQueue.length,
        mergeQueueMaxAttempts: this.mergeQueue.reduce((max, m) => Math.max(max, m.attempts ?? 0), 0),
        mergeQuarantineCount,
        mergeQuarantineKeys: [...this.mergeQuarantine.keys()],
        mergeHeldIds: [...(this.config.mergeHoldSummaryIds ?? [])],
        compressionQuarantineCount: 'count' in ledger ? ledger.count : null,
        unmergedFrontier: {
          l1: this.summaries.filter((s) => s.level === 1 && !s.mergedInto).length,
          l2: this.summaries.filter((s) => s.level === 2 && !s.mergedInto).length,
          l3: this.summaries.filter((s) => s.level === 3 && !s.mergedInto).length,
        },
        lastMintAt,
        topologyViolations: this.topologyViolations.length,
        topologyRefusals,
      };
      // Noted once the report is built, so a failure while building it isn't
      // taken for a success that re-arms the log.
      this.noteCompressionDebtFailure(error, 'error' in ledger ? ledger.error : undefined);
      return report;
    } catch (thrown) {
      const error = compressionDebtReportFailedMessage(thrown);
      this.noteCompressionDebtFailure(error, thrown);
      return {
        state: 'unknown',
        error,
        failure: 'report',
        pendingChunks: null,
        oldestPendingAgeMs: null,
        mergeQueueDepth: null,
        mergeQueueMaxAttempts: null,
        mergeQuarantineCount: null,
        mergeQuarantineKeys: null,
        mergeHeldIds: null,
        compressionQuarantineCount: null,
        unmergedFrontier: null,
        lastMintAt: null,
        topologyViolations: null,
        topologyRefusals: null,
      };
    }
  }

  /** Logs a debt report that couldn't read something, once: when one first fails,
   *  and again when the failure's text changes or after a report reads. The
   *  first report that reads after a failure logs that it does, once. */
  private noteCompressionDebtFailure(error: string | undefined, thrown: unknown): void {
    if (error === undefined) {
      if (this.compressionDebtFailureLogged === null) return;
      this.compressionDebtFailureLogged = null;
      try {
        this.diag.warn('[compression-debt] the report reads again');
      } catch {
        // A logger that throws mustn't turn a report that reads into `unknown`.
      }
      return;
    }
    if (error === this.compressionDebtFailureLogged) return;
    this.compressionDebtFailureLogged = error;
    try {
      // One line, so the namespace the diagnostics add to a message's first
      // line tags all of it. The message is a format string once the thrown
      // value follows it, so a '%' in it is doubled.
      this.diag.error(`[compression-debt] ${oneLine(error).replaceAll('%', '%%')}`, thrown);
    } catch {
      // A logger that throws mustn't make the report throw or lose what it read; the report still carries `error`.
    }
  }

  /**
   * Richer per-render stats: counts AND token sums for the head, the tail
   * (recent window), the raw middle and each summary level, so observers can
   * see "how much of the agent's context is in raw tail vs folded into
   * L1/L2/L3."
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
  // Neither delta is counted (a stub is about 36 tokens): the stats describe
  // the selection, not the byte-exact wire payload. Do not treat `total` as
  // an exact wire count.
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
      this.diag.warn(
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
  /** Store positions of the live messages under each emitted summary, kept
   *  while the store order and the summaries array are the ones they were
   *  read from. */
  private _coverageMemo: {
    order: ReadonlyMap<MessageId, number>;
    source: readonly SummaryEntry[];
    length: number;
    positions: Map<string, Int32Array>;
  } | null = null;

  protected assertFullCoverage(entries: ContextEntry[], messages: StoredMessage[], regions?: { headStart: number; headEnd: number; recentStart: number }): void {
    // Coverage by store position: marking is a lookup in the shared position
    // index instead of a set insert per covered id.
    const positionOf = this.positionIndex(messages);
    const covered = new Uint8Array(messages.length);
    const mark = (id: string): void => {
      const at = positionOf.get(id);
      if (at !== undefined) covered[at] = 1;
    };
    for (const e of entries) {
      const one = (e as { sourceMessageId?: string }).sourceMessageId;
      if (one) mark(one);
      // Composites (merged body-group shards) stand for several messages.
      const many = (e as { sourceMessageIds?: string[] }).sourceMessageIds;
      if (many) for (const id of many) mark(id);
    }

    // Expand emitted summaries down to the message ids they stand for. On the
    // store listing the positions under a summary are remembered, so a
    // summary emitted again marks a position list instead of re-walking its
    // sources through the index.
    const byStore = positionOf === this._storeOrder;
    let memo = byStore ? this._coverageMemo : null;
    if (byStore && (!memo || memo.order !== positionOf || memo.source !== this.summaries || memo.length !== this.summaries.length)) {
      memo = { order: positionOf, source: this.summaries, length: this.summaries.length, positions: new Map() };
      this._coverageMemo = memo;
    }
    for (const rootId of this._emittedSummaryIds) {
      const kept = memo?.positions.get(rootId);
      if (kept) {
        for (let k = 0; k < kept.length; k++) covered[kept[k]] = 1;
        continue;
      }
      const found: number[] = [];
      const seen = new Set<string>();
      const stack: string[] = [rootId];
      while (stack.length > 0) {
        const id = stack.pop();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const sum = this.summaryById(id);
        if (!sum) continue;
        if (sum.sourceLevel === 0) {
          for (const mid of sum.sourceIds) {
            const at = positionOf.get(mid);
            if (at !== undefined) { covered[at] = 1; found.push(at); }
          }
        } else {
          for (const child of sum.sourceIds) stack.push(child);
        }
      }
      memo?.positions.set(rootId, Int32Array.from(found));
    }

    const missing: string[] = [];
    if (byStore) {
      // The store listing sits at its own positions; a position not marked is
      // re-read through the index so a repeated id resolves as before.
      for (let i = 0; i < messages.length; i++) {
        if (covered[i] !== 1 && covered[positionOf.get(messages[i].id)!] !== 1) missing.push(messages[i].id);
      }
    } else {
      for (const m of messages) if (covered[positionOf.get(m.id)!] !== 1) missing.push(m.id);
    }
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
    this._lastFoldDiff = null;
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
  /** `performance.now()` at the top of the current `select()`; rsEnd() stamps
   *  the base `select()`'s elapsed time on the plan-vs-actual line from it. */
  private _selectStartedAt = 0;
  /** Length of the strategy's view of the branch at the top of `select()`,
   *  whichever chunker runs; rsEnd() logs it as `messages=`. */
  private _selectMessages = 0;

  /** Fold diff of THIS compile, for `planVsActual`: reset with the other
   *  figures of the pass (`rsBegin`, dry runs included) and set only when a
   *  compile that changed at least one saved level commits. It describes the
   *  compile it is attached to, so a quiet compile has none. */
  private _lastFoldDiff: FoldDiff | null = null;

  /**
   * `[fold-diff]` for a compile that has just committed saved-level changes:
   * which chunks moved between which levels, and where its request first
   * differs from the last one returned, in its entries' tokens
   * (`firstChanged`, the entry index `placeCacheMarkers` measured; null with
   * no earlier compile). Logged
   * once and returned for `planVsActual`. Observability never fails a
   * compile: a throw is reported, and the compile goes on without it.
   */
  private logFoldDiff(
    inputs: PickerInputs,
    middleChunkCount: number,
    levelAt: (sequence: number, id: ChunkId) => number,
    entries: ContextEntry[],
    firstChanged: number | null,
  ): FoldDiff | null {
    try {
      // The middle chunks are the prefix of the inputs' chunks. Each carries
      // the level it was planned from, and `levelAt` answers the level this
      // compile gave it without materializing the solver's frontier map.
      const middle = inputs.chunks.slice(0, middleChunkCount);
      const carried = new Map<ChunkId, number>(middle.map((c) => [c.id, c.currentResolution]));
      const next = new Map<ChunkId, number>(middle.map((c) => [c.id, levelAt(c.sequence, c.id)]));
      let divergence: RequestDivergence | null = null;
      if (firstChanged !== null) {
        let offset = 0;
        let suffixTokens = 0;
        entries.forEach((entry, index) => {
          const tokens = this.estimateTokens(entry.content);
          if (index < firstChanged) offset += tokens;
          else suffixTokens += tokens;
        });
        divergence = { offset, suffixTokens };
      }
      const diff = describeFoldDiff(inputs, new SummaryTree(inputs), carried, next, divergence);
      this.diag.error(formatFoldDiff(diff));
      return diff;
    } catch (err) {
      this.diag.warn('[fold-diff] unavailable for this compile:', err);
      return null;
    }
  }

  protected rsSummary(level: number, tokens: number, id?: string): void {
    if (id) this._emittedSummaryIds.add(id);
    const r = this._rs;
    if (!r) return;
    const k: 'l1' | 'l2' | 'l3' = level <= 1 ? 'l1' : level === 2 ? 'l2' : 'l3';
    r.summaries[k].count += 1;
    r.summaries[k].tokens += tokens;
  }

  /** Commit the accumulated stats as the last-render snapshot, and return
   *  it; null when this pass recorded none. */
  protected rsEnd(): RenderStats | null {
    const r = this._rs;
    if (!r) return null;
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
    // whatever renders last (the recent window). Logged on every adaptive
    // compile that returns, so the drift is observable before it becomes an
    // eviction.
    if (this._plannedTokens !== null) {
      const actual = r.total.tokens;
      const planned = this._plannedTokens;
      const delta = actual - planned;
      const pct = planned > 0 ? (delta / planned) * 100 : 0;
      const m = this._plannedMeta;
      // Whole ms: the journal line stays greppable and a before/after across
      // versions needs no parsing of fractions.
      const compileMs = Math.round(performance.now() - this._selectStartedAt);
      // kv-unified's certificate time is spent inside baseSolveMs, so it is
      // not added again here.
      const kt = m?.solver === 'kv-unified' ? this._lastKvUnified?.lastTimings : null;
      const solveMs = kt ? Math.round(kt.forestMs + kt.baseSolveMs + kt.demandMs) : undefined;
      // What the label ceiling stopped in that solve (#252).
      const ceiling = ceilingMark(kt?.ceiling);
      const messages = this._selectMessages;
      // Dry runs and previews log the line too, and skip work a live compile
      // does, so a journal reader must be able to drop them.
      const dryRun = this._dryRunSelect;
      r.planVsActual = {
        planned,
        actual,
        delta,
        budgetMet: m?.budgetMet ?? false,
        exhausted: m?.exhausted ?? false,
        moves: m?.moves ?? 0,
        ...(m?.solver !== undefined ? { solver: m.solver } : {}),
        messages,
        compileMs,
        ...(solveMs !== undefined ? { solveMs } : {}),
        ...(ceiling ? { ceiling } : {}),
        ...(dryRun ? { dryRun: true as const } : {}),
        ...(this._lastFoldDiff ? { foldDiff: this._lastFoldDiff } : {}),
      };
      // Loud only when the emitter OVERRUNS the plan — that is the direction
      // that costs the tail. Under-spend is harmless slack.
      const loud = delta > 0 && Math.abs(pct) >= 2;
      const line =
        `[plan-vs-actual] planned=${planned} actual=${actual} delta=${delta >= 0 ? '+' : ''}${delta}` +
        ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) budgetMet=${m?.budgetMet} exhausted=${m?.exhausted}` +
        ` moves=${m?.moves} solver=${m?.solver} messages=${messages} compileMs=${compileMs}` +
        (solveMs !== undefined ? ` solveMs=${solveMs}` : '') +
        (ceiling ? ` ceiling=${ceiling}` : '') +
        (dryRun ? ' dryRun=true' : '');
      if (loud) this.diag.warn(`${line} — emitter overran the plan; the overrun is paid by the recent window`);
      else this.diag.error(line);
    }
    r.calibration = {
      multiplier: this._calibration,
      pricingEpoch: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH,
      ...(this._calibrationProvisional ? { provisional: true as const } : {}),
      ...(this._calibrationReset ? { reset: this._calibrationReset } : {}),
    };
    this._lastRenderStats = r;
    this._rs = null;
    return r;
  }

  /**
   * Stats describing the last live compile: the snapshot its `select()`
   * recorded as it emitted each entry. Null until a live select has run since
   * the strategy loaded its branch (`initialize`, a branch reload). The stats
   * depend on the budget a compile is given, which this read isn't, so nothing
   * stands in for them before one: the pyramid of live summaries this used to
   * return instead was neither the hierarchical cut nor the adaptive one (#304,
   * connectome-host#425). A dry run or preview leaves them as they were (see
   * `select()`); its own stats come back with it.
   */
  getRenderStats(_store: MessageStoreView): RenderStats | null {
    this.requireLoadedBranch('getRenderStats');
    return this._lastRenderStats;
  }

  /**
   * The stats the most recent `select()` on this branch recorded, live or
   * dry, or null when it recorded none (it was refused). A compile reads them
   * right after its select, so a dry compile's result carries its own stats,
   * which `getRenderStats()` never returns.
   */
  getLastSelectStats(): RenderStats | null {
    return this._lastSelectStats;
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

    // Without estimates (the hierarchical selection), the pruned form's
    // own, with its images whole: that selection's strip counts only the
    // images it sends, or, with imageStripHysteresisRatio, applies that
    // option's set, and it prices no image as the placeholder either way.
    const est = (i: number): number => pse?.[i] ?? store.estimateTokens(this.prunedForSend(store, messages[i]!));
    const accepted: number[] = [];
    let acceptedTokens = 0;
    for (let i = messages.length - 1; i >= recentStart; i--) {
      const tokens = est(i) + this.cappedForSend(store, messages[i], msgCap).extra;
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
        this.diag.warn(
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
      const { content, extra } = this.cappedForSend(store, msg, msgCap);
      const tokens = est(i) + extra;
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
   * Persist the request that authored a mint, keyed by the `requestHash`
   * its `provenance` carries (src/mint-preimage.ts). Runs at ACCEPTANCE, not
   * at dispatch: refused and quarantined attempts are not mints, and a
   * compression context is large enough that storing every rung of a refusal
   * curve would multiply store growth for receipts nobody minted against.
   * Opt-in: only an explicit `persistMintPreimages: true` enables it, so a
   * host that never configured it — including one that pulls this version
   * into a running deployment, and one that passes an unset flag straight
   * through into the options — writes nothing.
   */
  private persistMintPreimage(
    ctx: StrategyContext,
    request: NormalizedRequest | undefined,
    requestHash: string,
  ): void {
    if (this.config.persistMintPreimages !== true) return;
    if (!request) {
      this.diag.error(
        `[autobiographical] no authoring request retained for accepted mint ${requestHash} — ` +
          'provenance stays verifiable but unreadable',
      );
      return;
    }
    persistMintRequestPreimage(ctx.store, request, requestHash, this.diag);
  }

  /**
   * Compress a raw message chunk into an L1 summary using self-voice framing.
   * The request's `system` field carries the HOST's live prompt when one has
   * been declared (ContextManager.setSystemPrompt -> ctx.systemPrompt), and
   * is absent entirely when none has — undeclared, framing is by message
   * structure only. Never a synthetic summarizer header on either path. Full
   * rationale, and the currency caveat on the declared path, at the request
   * builder below.
   */
  protected async compressChunkHierarchical(
    chunk: Chunk,
    ctx: StrategyContext,
    // Only the authoritative durable-family gate reports a no-op skip. This
    // optional notification preserves the Promise<void> subclass contract.
    onQuarantineSkip?: () => void,
    // The chunk's request was found or made unable to go, so this process
    // won't retry it while that lasts: the overlap guard while the overlap
    // stands, a joined call whose family the reloaded ledger holds, or an
    // exhaustion whose record the ledger holds. tick ends the chunk's runs
    // on it (endChunkFailureRuns).
    onRequestStopped?: () => void,
    // The work this compression joined was thrown away, its strategy let go
    // of, and left no L1 and no quarantine: no call was made here, and the
    // chunk is still to do. tick puts it back at the head of its queue,
    // unless a rebuild during the wait decided otherwise. An override that
    // doesn't pass it on leaves the chunk to the next rebuild, as a return
    // that made no call does.
    onJoinedWorkDiscarded?: () => void,
  ): Promise<void> {
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
      // The span is covered: its ladder progress and quarantine debt are paid
      // off, as at a mint (the paid-off sweep judges by the persisted mark,
      // which a store without chunk persistence doesn't keep).
      await this.clearQuarantineForCompressedChunk(chunk);
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
    //    left uncompressed as an operator breadcrumb (a compressed record
    //    with no summary of its own is reset to raw on load). The span is
    //    covered all the same, so its ladder progress and any quarantine
    //    debt are paid off here, as adoption does: the paid-off sweep judges
    //    by the persisted mark, which this path doesn't set.
    if (chunk.messages.length > 0 && chunk.messages.every(m => coveredByL1.has(m.id))) {
      this.diag.warn(
        `[autobiographical] dedup guard: chunk ${chunk.recordId ?? `#${chunk.index}`} ` +
        `is fully covered by existing L1s under different boundaries — dropped, not re-compressed.`,
      );
      chunk.compressed = true;
      await this.clearQuarantineForCompressedChunk(chunk);
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
        this.diag.error(
          `[autobiographical] OVERLAP GUARD: refusing to compress chunk ` +
          `${chunk.recordId ?? `#${chunk.index}`} — ${overlapIds.length}/${chunk.messages.length} ` +
          `of its messages are already covered by existing L1 summaries ` +
          `(first: ${overlapIds[0]}). Duplicate-memory formation blocked; ` +
          `investigate before resuming this span.`,
        );
      }
      // Refused on every attempt while the overlap stands, so no retry fills
      // the span meanwhile: the merges beside it stop waiting.
      onRequestStopped?.();
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
    const substantiveChars = this.thinChunkChars(chunk);
    if (substantiveChars !== undefined) {
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
        // Stamped as an L1 of the same chunk would be, so a merge of
        // inherited summaries that includes a quiet stretch stays witnessed.
        ...(this.chunkIsWitnessed(chunk) ? { witnessed: true } : {}),
      };
      this.pushSummary(stub);
      chunk.compressed = true;
      chunk.summaryId = stub.id;
      this.markChunkRecordCompressed(chunk.recordId, stub.id);
      this._compressionCount++;
      // The span is covered, so its progress and quarantine debt are paid
      // off. A stub made no call, so it is no landing (noteCompressionLanded).
      await this.clearQuarantineForCompressedChunk(chunk);
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
      }, this.ns);
      // As after a written L1: a strategy let go of, or loaded again, while
      // the clear above waited leaves the merge check to the strategy that
      // holds the branch now.
      if (!this.isCompressionBranchCurrent(sourceBranch)) return;
      this.checkMergeThreshold();
      return;
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
    //      order is also the KV-stable order: chunks of one topic after its
    //      head share that head, so their requests share its prefix. The
    //      head is the head as of the chunk (headAsOf): after a head-window
    //      reset, the head that history followed, the opening or its own
    //      topic's, never the later topic's. (executeMerge always had
    //      head-first; this site was the odd one out.)
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
    const allMessages = ctx.messageStore.getAll();
    // Message IDs are opaque strings, not sortable sequence numbers. Chronicle's
    // default IDs happen to be decimal text, where lexical order corrupts the
    // timeline at the first width transition (`"103" < "15"`). Use the store's
    // canonical order instead so recall pairs remain chronological for every ID
    // representation and newly-created summaries extend rather than splice the
    // provider-cache prefix.
    const messageOrder = new Map<MessageId, number>(
      allMessages.map((message, index) => [message.id, index]),
    );
    const chunkFirstId = chunk.messages[0]?.id;
    // The chunk's start is its first message still in the store: a host can
    // remove a stored message (agent-framework's Discord module does, on a
    // delete) while the chunk holding it waits in the queue. -1 only when
    // none of its messages is left (startInStore).
    const chunkStartIdx = this.startInStore(chunk.messages.map((m) => m.id), messageOrder);
    // The head as of the chunk (headAsOf): after a head-window reset, history
    // from before it is given the head it followed, not the new topic's, which
    // came after it. Clipped at a hold there, as before.
    const { start: headStartIdx, end: headEndIdx } = this.headAsOf(ctx.messageStore, chunkStartIdx);

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
    // Pins in the canonical L1 prompt. The live view shows a message that a
    // pin keeps raw (forceRawPinPositions) raw, so this prompt does too. A
    // frontier summary that can't be shown as a recall pair (it covers such a
    // message, or its content is empty) is DESCENDED, not dropped: its
    // children take its place, so only the branch holding the pin opens,
    // sibling branches stay recall pairs, and the raw a pin adds is its own
    // L1 chunk. This mirrors the live selector (kv-control keeps protected
    // raw leaves beside their group's recall). Dropping the whole frontier
    // summary instead replayed an entire L3/L4 raw on every L1 while one pin
    // existed.
    //
    // The L1s a pin opens are recorded (openedChunks). Their messages render
    // raw wherever they lie before the chunk, including before the head
    // window; the head window always comes first, and after it they go in
    // source order with the recall pairs (section 2). Only they lose
    // coverage, so a merged L1 the descent can't reach (a parent whose
    // sourceIds miss it) stays covered, as on main, unless a pin opens it.
    // The raw that pins add is spent from the recall budget (below).
    //
    // Scope: the canonical L1 prompt, and only pins before the chunk. Merge
    // recall, L3+ merge inputs and transition summaries do not consult pins,
    // and the source-only L1 shows no history for them to change.
    // Priced as the store prices a message, images and tool blocks included,
    // under every selector (the strategy's own estimator falls back to text
    // alone outside adaptive selection).
    const tokensOf = (content: ContentBlock[]): number =>
      ctx.messageStore.estimateTokens({ content } as unknown as StoredMessage);
    // A stored message as a compression request sends it (sentTokensOf below).
    const sentTokensOf = (content: ContentBlock[]): number => this.sentTokensOf(content, ctx);

    // Residence-scoped source-only L1 compression (see `compressionSourceOnly`
    // in strategy config). When on, sections 1 (head) and 2 (recall pairs and
    // raw middle) below are skipped structurally — the summarizer receives
    // ONLY the marker + exact target chunk + directive (sections 4–6). Tools
    // stay declared (reasoning_extraction guard). L1 only; merge/transition
    // paths do not consult this flag.
    const sourceOnly = this.config.compressionSourceOnly === true;

    // History before the chunk, laid out for the messages that pins keep raw.
    const layoutHistory = (forceRawMessageIds: ReadonlySet<MessageId>) => {
      // The recall frontier, the chunks pins open and the leaf coverage, as
      // compressionWorkQueued's count reads them too (recallCoverage).
      const { frontier, openedMessageIds, coveredMessageIds: priorSummaryMessageIds } = this.recallCoverage(forceRawMessageIds);
      // Recall pairs only for history before the chunk: a summary whose
      // source range starts before the chunk's first message, as a merge's
      // prior recall set takes only what starts before its range (1a). A
      // chunk compressed after later history already has summaries (the old
      // head's chunk, which a head-window reset makes compressible after the
      // chunks behind it; a pinned or quarantined chunk let go late) was
      // given their recall pairs too, ahead of it: what came after it
      // (#317). It now sees fewer pairs: only those that start before it.
      // Coverage is the whole frontier's still, so a later summary's
      // messages stay out of the raw middle (one-to-one). A summary that
      // starts before the chunk and reaches past it (a sparse sweep
      // artifact, issue #42) is still recalled, since the messages it covers
      // before the chunk have no other form here; so its later part, what it
      // says of history after the chunk, still reaches this request, and only
      // where a summary straddles the chunk. A summary written before this
      // rule may also carry what came after its own history, from the head or
      // recall pairs it was written with; that stays in its text. Where a
      // summary starts is summaryStartInStore's rule, the one
      // a merge's prior recall set uses: a summary whose first message a host
      // removed starts at its first message still there, and one with none
      // left isn't recalled. A chunk with no message left (chunkStartIdx -1)
      // recalls none.
      const summariesById = new Map<string, SummaryEntry>();
      for (const s of this.summaries) summariesById.set(s.id, s);
      const startOf = new Map<string, number>();
      for (const s of frontier) startOf.set(s.id, this.summaryStartInStore(s, messageOrder, summariesById));
      const priorSummaries = frontier
        .filter((s) => { const at = startOf.get(s.id)!; return at >= 0 && at < chunkStartIdx; })
        .sort((a, b) => startOf.get(a.id)! - startOf.get(b.id)! || a.sourceRange.first.localeCompare(b.sourceRange.first));

      // Raw messages before the chunk outside the head window, by position.
      // From the head window's end on, any message no summary represents yet
      // (the raw middle: usually empty in adaptive-resolution mode, since
      // chunking proceeds contiguously and summaries cover everything up to
      // the chunk being processed). Before it, only what pins keep raw: the
      // chunks a pin opened, and pinned messages no recall pair represents.
      // Same one-to-one rule as the head: coverage is judged against
      // `priorSummaryMessageIds`.
      //
      // The raw that pins add to this prompt (`pinnedRaw`) is what recalling
      // their summaries would take out: the messages of opened chunks,
      // wherever they render, and pinned messages before the head window,
      // which no prompt showed before. It's spent from the recall budget
      // before any recall pair. A pinned message from the head window on
      // that no summary covers was never chunked, since the chunker skips
      // what pins keep raw; it renders raw with or without the pins and has
      // no summary to recall, so it isn't charged here. When pins are
      // admitted, the request's price includes it.
      const rawMiddle: Array<{ position: number; message: StoredMessage }> = [];
      const pinnedRaw: number[] = [];
      let pinnedRawTokens = 0;
      if (!sourceOnly) {
        const addPinnedRaw = (position: number, message: StoredMessage): void => {
          pinnedRaw.push(position);
          pinnedRawTokens += sentTokensOf(message.content);
        };
        // The head window renders in section 1; an opened chunk there is raw
        // that pins add.
        for (let i = headStartIdx; i < headEndIdx && i < allMessages.length; i++) {
          const m = allMessages[i];
          if (openedMessageIds.has(m.id) && !priorSummaryMessageIds.has(m.id)) addPinnedRaw(i, m);
        }
        for (let i = 0; i < chunkStartIdx && i < allMessages.length; i++) {
          if (i >= headStartIdx && i < headEndIdx) continue;
          const m = allMessages[i];
          if (priorSummaryMessageIds.has(m.id)) continue;
          const addedByPin = openedMessageIds.has(m.id) || (i < headEndIdx && forceRawMessageIds.has(m.id));
          if (!addedByPin && i < headEndIdx) continue;
          if (addedByPin) addPinnedRaw(i, m);
          rawMiddle.push({ position: i, message: m });
        }
      }
      return { priorSummaries, startOf, priorSummaryMessageIds, rawMiddle, pinnedRaw, pinnedRawTokens };
    };

    // When the chunk is a portion of a substantially larger sharded message
    // (≥ 2× chunk size), section 6 uses the reading-mode instruction. It
    // avoids the "form a memory of what this contained" framing — which, for
    // content heavily first-person from someone other than the agent (a
    // user-shared doc), leads the model to adopt the content author's voice.
    // Instead, it asks what reading was like and what was learned, forcing
    // the model to reflect from its own vantage point in agent-first-person.
    // Worked out here, before the layout, since admitting pins prices it.
    const docContext = this.detectDocContext(chunk, ctx);
    const instructionText = this.applyIdentityReminder(
      docContext
        ? this.getReadingChunkInstruction(chunk, docContext.totalTokens, targetTokens)
        : this.getCompressionInstruction(chunk, targetTokens),
      this.chunkIsWitnessed(chunk),
    );
    // Generous output ceiling so a memory-write is never truncated mid-thought:
    // targetTokens is a *target*, not a cap, and adaptive models routinely
    // overshoot a ~2k target. Was `* 1.5` (=3000 at the 2k default), which cut
    // off rich memories (stop=max_tokens).
    const outputReserveTokens = this.capCompressionTokens(Math.max(16000, Math.round(targetTokens * 1.5)));

    // Pins count only before the chunk being compressed: this prompt is the
    // history the chunk follows. A summary after it (a chunk compressed out of
    // order, after a head-window reset or an unpin) isn't recalled at all
    // (layoutHistory), and its messages stay covered.
    const forceRawMessageIds = new Set<MessageId>();
    for (const i of this.forceRawPinPositions(allMessages)) {
      if (i < chunkStartIdx) forceRawMessageIds.add(allMessages[i].id);
    }
    const recallBudget = sourceOnly ? 0 : (this.config.compressionRecallBudgetTokens ?? 100_000);

    // The canonical request's messages for one layout of history, sections 1
    // to 6, shaped as they are sent. Admitting the pins prices this list.
    const assemble = (
      { startOf, priorSummaryMessageIds, rawMiddle }: ReturnType<typeof layoutHistory>,
      keptSummaries: readonly SummaryEntry[],
    ) => {
      const llmMessages: Array<{ participant: string; content: ContentBlock[] }> = [];

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
      // prefix the original instance saw ahead of this history: the head
      // window as of the chunk (headAsOf), which after a head-window reset
      // is the opening, or the transition and opening of the chunk's topic.
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
      for (let i = headStartIdx; !sourceOnly && i < headEndIdx && i < allMessages.length; i++) {
        const m = allMessages[i];
        if (priorSummaryMessageIds.has(m.id)) {
          headCoveredSkipped++;
          continue;
        }
        llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
      }

      // ---- 2. Prior recall pairs (budget-capped, above) and the raw middle ----

      // One sequence by source position after the head window, which always
      // comes first, so the summarizer never reads an older raw turn, or an
      // older memory, as coming after a later memory. A recall pair sits at
      // its summary's start as the recall filter read it (layoutHistory's
      // startOf, summaryStartInStore): a summary whose first message a host
      // removed sits at its first message still in the store, not last.
      // Where the raw middle follows every recall pair, as it does when
      // chunking runs contiguously, this is the order the prompt always had:
      // recall pairs, then raw.
      const middle: Array<{ position: number; summary?: SummaryEntry; message?: StoredMessage }> = [
        ...keptSummaries.map((summary) => ({
          position: startOf.get(summary.id) ?? Number.MAX_SAFE_INTEGER,
          summary,
        })),
        ...rawMiddle,
      ].sort((a, b) => a.position - b.position);
      for (const { summary: s, message: m } of middle) {
        if (m) {
          llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
          continue;
        }
        llmMessages.push({
          participant: 'Context Manager',
          content: [{ type: 'text', text: `[CM] Recall memory ${s!.id}.` }],
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
          content: this.summaryAnswerContent(s!),
        });
      }

      // ---- 4. In-band marker ----
      // Structural start of the exact source-only shape. Never recover this by
      // searching text: the target itself may quote the marker.
      const sourceOnlyStartIndex = llmMessages.length;
      llmMessages.push({
        participant: 'Context Manager',
        content: [{ type: 'text', text: COMPRESSION_MARKER }],
      });

      // ---- 5. Chunk messages raw ----
      for (const m of chunk.messages) {
        llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
      }

      // ---- 6. Instruction (reading-mode aware; worked out above) ----
      llmMessages.push({
        participant: 'Context Manager',
        content: [{ type: 'text', text: instructionText }],
      });

      // Split any bundled tool_use+tool_result cycles in non-user turns into
      // separate API-shape messages. claude.ai-imported sessions carry these
      // bundles (a tool_result in an assistant message rejects the request);
      // for fresh imports the conhost importer splits at ingest time, but
      // already-warmed sessions hit this path. See `normalize-tool-messages.ts`.
      // First each recall answer is kept apart from the agent's own raw turn
      // after it (RECALL_RESUME_TEXT), so the collapse below can't join them.
      const split = splitMixedToolMessages(this.separateRecallAnswers(llmMessages));

      // Collapse consecutive same-participant messages for API compliance
      const collapsed = this.collapseConsecutiveMessages(split);

      // Defense in depth against chunk boundaries that cut a tool cycle
      // (rebuildChunks tries to avoid this, but covers only the most common
      // case). The API rejects any tool_use that isn't immediately followed
      // by its tool_result, and any tool_result that doesn't follow a use.
      const cleaned = stripUnpairedToolBlocks(collapsed);

      return { llmMessages, sourceOnlyStartIndex, cleaned, headCoveredSkipped };
    };

    // The store's price of a built request as it is sent: each message with
    // its serialized media replaced, as runAttempt prepares it. Its thinking
    // is priced as it stands: the raw messages' was stripped as the request
    // was built, and a recall answer's signed reasoning is sent. Then the
    // system prompt and the tools, which are sent as they are, and the
    // output reserve.
    const priceRequest = (messages: ReadonlyArray<{ content: ContentBlock[] }>): number => {
      let total = outputReserveTokens +
        (ctx.systemPrompt ? tokensOf([{ type: 'text', text: ctx.systemPrompt }]) : 0) +
        (ctx.tools && ctx.tools.length > 0 ? tokensOf([{ type: 'text', text: JSON.stringify(ctx.tools) }]) : 0);
      for (const message of messages) total += this.preparedTokensOf(message.content, ctx);
      return total;
    };

    let history = layoutHistory(forceRawMessageIds);
    // Token-budget cap (see capRecallPairs), after the raw that pins add.
    // Defense-in-depth: even with merged exclusion the unmerged frontier can
    // be large at extreme scale. Source-only mode uses a zero recall budget:
    // capRecallPairs returns an empty set, so no recall pair is emitted below
    // AND buildRecallCurveVariants has no frontier to expand (canonical-only,
    // one call).
    let recall = this.capRecallPairs(history.priorSummaries, recallBudget - history.pinnedRawTokens);
    let built = assemble(history, recall.kept);
    // Pins are honored here only if the raw they add fits the recall budget
    // and the request with it fits compressionContextBudgetTokens, priced as
    // the store prices the messages it would send (priceRequest), with the
    // system prompt, tools and output reserve. Images are priced at the
    // store's estimate in both, though the request's inline image cap can
    // replace some with placeholders. The raw's charge against the recall
    // budget also counts a pinned tool block whose partner isn't in the
    // request, which the request drops; the request's own price, of
    // built.cleaned, doesn't. So the gate errs toward recall. The request is
    // priced with the longer of the lines a retry appends to the instruction
    // (withNoToolsLine, withPlainProseLine), so a retry fits too. The
    // recall-curve variants and the opt-in tool-prose rung aren't priced
    // here: each is admitted on its own when the ladder reaches it
    // (compressionAdmission). A request without pins is always attempted, as
    // before.
    // Otherwise this compression lays history out as if no pin applied,
    // recalling the summaries the pins override, and says so once it goes
    // ahead. Waiting for the pins to fit would stall every later L1 too,
    // since the pinned history precedes each of them, and with them the L1s
    // the live selector needs when even its deepest fold is over budget. The
    // live view still shows the pins raw.
    let pinsOverBudget: { history: typeof history; requestTokens?: number; contextBudget: number } | undefined;
    if (history.pinnedRawTokens > 0) {
      const contextBudget = this.normalizedCompressionContextBudget();
      const requestTokens = history.pinnedRawTokens <= recallBudget
        ? Math.max(...L1_RETRY_LINES.map((line) => priceRequest(withLineAppended(built.cleaned, line))))
        : undefined;
      if (requestTokens === undefined || requestTokens > contextBudget) {
        pinsOverBudget = { history, requestTokens, contextBudget };
        history = layoutHistory(new Set());
        recall = this.capRecallPairs(history.priorSummaries, recallBudget);
        built = assemble(history, recall.kept);
      }
    }
    const { priorSummaries, pinnedRawTokens } = history;
    const { kept: keptSummaries, keptTokens: recallTokens } = recall;
    const { llmMessages, sourceOnlyStartIndex, cleaned, headCoveredSkipped } = built;

    const sourceOnlyFallbackMessages = this.config.compressionSourceOnlyFallback === true && !sourceOnly
      ? structuredClone(llmMessages.slice(sourceOnlyStartIndex))
      : undefined;

    // Without the agent's live tool definitions a summarizer request that
    // replays tool-block-bearing history is deterministically refused
    // (reasoning_extraction -- see the `tools` comment below; labclaude
    // 2026-07-09). On Fable/Mythos-family summarizers the refusal is
    // content-INDEPENDENT: the bare marker+directive with no conversation
    // at all is input-blocked, while the identical bytes with the live tool
    // set declared mint cleanly (Linn, claude-fable-5-1, 2026-09-05; same on
    // claude-fable-5). A pure-chat seed's first speculative L1 therefore
    // fired ~300ms after boot -- before the host's first
    // setToolDefinitions -- burned a doomed call and landed in quarantine.
    // Tools are pushed by the host on MCPL registration / maintenance
    // passes and on every activation, so defer rather than burn the call.
    // Opus-family summarizers mint tools-less (lena bench), and test
    // harnesses never push tools, so the content-independent rule is gated
    // on the model family.
    // compressionWorkQueued's count applies the same test (hasToolBlocks).
    const chunkHasToolBlocks = cleaned.some((m) => hasToolBlocks(m.content));
    const toolsLessRefusingFamily = isToolsLessRefusingSummarizer(this.config.compressionModel ?? "");
    if ((chunkHasToolBlocks || toolsLessRefusingFamily) && !(ctx.tools && ctx.tools.length > 0)) {
      this.diag.warn(`[autobiographical] deferring chunk compression: host has not provided tool definitions yet (ctx.tools empty; ${chunkHasToolBlocks ? 'history contains tool blocks' : 'Fable/Mythos-family summarizer refuses tools-less requests'}) — will retry after tools are pushed`);
      return;
    }

    // The HOST's system prompt, or none — never a synthetic one. With no
    // host prompt declared (ctx.systemPrompt undefined) the request carries
    // no system field at all: the agent's identity is established by the
    // head (the actual conversation opening — user message + agent reply
    // that grounded the original instance), and a summarizer-only header
    // would (a) add a synthetic header the original instance never saw,
    // disturbing KV consistency between the summarizer and the original
    // instance, and (b) provide an alternative identity source that competes
    // with the structural one carried by the conversation itself. Both
    // objections invert when the host DOES serve a system prompt on every
    // activation, because then the header is no longer synthetic.
    //
    // Be precise about WHICH prompt this is, because the mechanism does not
    // supply the one the wording would suggest: ContextManager keeps only
    // the LATEST value the host pushed (setSystemPrompt), never a
    // per-message historical prompt, so what is threaded here is the host's
    // CURRENT identity policy governing this mint — not a replay of what the
    // original instance was served while the chunk was being lived. Where
    // the prompt is stable across that span, the two coincide and replaying
    // it is the KV-honest reconstruction; where the host has changed it, the
    // memory is authored under the identity the host serves NOW, and this
    // code has no way to recover the older one. On either reading, omitting
    // it is what installs a competing (system-promptless) identity.
    // See ContextManager.setSystemPrompt.
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

    const authoredRequest: NormalizedRequest = {
      // Served FIRST, ahead of the head — the live activation's own layout
      // (system prompt -> head -> middle). Conditionally spread rather than
      // assigned: an undeclared prompt must leave the request shape, its
      // canonical hash and its quarantine identity byte-identical to what
      // they were before this field existed.
      ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
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
        maxTokens: outputReserveTokens, // generous, never truncating (above)
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

    // The canonical request is the authored one prepared. Recall-curve variants
    // are built from the authored request, and each is prepared on its own:
    // a variant is found by matching a recall pair's answer against the stored
    // authored answer, which a prepared answer may no longer equal.
    const request = this.prepareCompressionAhead(authoredRequest);
    let sourceOnlyFallbackRequest: NormalizedRequest | undefined;
    if (sourceOnlyFallbackMessages) {
      const sourceOnlyCleaned = stripUnpairedToolBlocks(
        this.collapseConsecutiveMessages(splitMixedToolMessages(sourceOnlyFallbackMessages)),
      );
      const sourceOnlyFallbackWireMessages = sourceOnlyCleaned
        .map(m => ({ participant: m.participant, content: stripEmptyTextBlocks(m.content) }))
        .filter(m => m.content.length > 0);
      // Keep the final rung wire-identical to legacy direct source-only. With
      // an empty recall ladder this places no owned seam/TTL, but when cache
      // markers are enabled it still strips stale imported block-level
      // cache_control before dispatch. The kill switch preserves passthrough.
      this.applyMintCacheSeams(sourceOnlyFallbackWireMessages, [], false);
      sourceOnlyFallbackRequest = {
        ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
        shedOversizeImages: true,
        messages: sourceOnlyFallbackWireMessages,
        config: structuredClone(request.config),
        tools: ctx.tools,
      };
    }

    if (sourceOnlyFallbackRequest) {
      sourceOnlyFallbackRequest = this.prepareCompressionAhead(sourceOnlyFallbackRequest);
    }

    // Retain the exact prepared canonical request and authored frontier. Variants are
    // derived solely by replacing one isolated recall pair; the canonical call
    // below is always issued first and is never rebuilt through fallback code.
    const canonicalRequestHash = sha256Json(request);
    const sourceOnlyFallbackRequestHash = sourceOnlyFallbackRequest
      ? sha256Json(sourceOnlyFallbackRequest)
      : undefined;
    const variants = this.buildRecallCurveVariants(
      authoredRequest,
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
      undefined,
      sourceOnlyFallbackRequestHash,
    );
    const runSubject = chunkRunSubject(quarantineRecord.chunkSourceHash, chunk.messages);
    // The attempt's first read of the ledger, before any model call: while
    // the ledger can't be read, every attempt that would call the model
    // stops here, so the error says what that means for the agent. A chunk
    // adopted, covered or stubbed above needs no model and has returned
    // before this; the attempt's later reads come after this one; and load,
    // the sweep and an operator's clear meet the failure in their own terms.
    let durableQuarantine: Map<string, ActiveCompressionQuarantine>;
    try {
      durableQuarantine = this.readCompressionQuarantineProjection();
    } catch (error) {
      throw new CompressionQuarantineUnreadableError(error);
    }
    const durableActive = this.durableQuarantineFor(durableQuarantine, quarantineRecord);
    if (durableActive) {
      this.compressionRefusalQuarantine = durableQuarantine;
      if (!this.warnedQuarantineSkips.has(quarantineRecord.chunkSourceHash)) {
        this.warnedQuarantineSkips.add(quarantineRecord.chunkSourceHash);
        this.diag.warn(
          `[autobiographical] compression quarantine skipped chunk ${chunk.recordId ?? `#${chunk.index}`} ` +
            `(hash=${quarantineRecord.chunkSourceHash.slice(0, 12)}, key=${durableActive.record.key.slice(0, 12)}): ` +
            `provider call skipped; chunk remains raw`,
        );
      }
      onQuarantineSkip?.();
      logCompressionCall({
        event: 'compression:quarantine-skipped',
        operation: 'compress_l1',
        metadata: {
          quarantine_key: durableActive.record.key,
          model,
          chunk_message_ids: chunk.messages.map((message) => message.id),
          canonical_request_hash: canonicalRequestHash,
        },
      }, this.ns);
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
      if (result.error) {
        // The producer's transient failure was on the very request this
        // instance would send next: take the wait the provider stated after
        // that call, counting no failure, since none of this instance's calls
        // failed. Only on the producer's route: no provider stated a wait to a
        // waiter whose membrane is another, so it takes none. Every waiter
        // rethrows the failure, and tick puts its chunk back as after a
        // failure of its own: after a transient one, at the back of its queue,
        // to be asked again on its own route. A deferral made no call (the
        // producer's admission refused it, or its split rung's window had no
        // room), so no provider stated a wait for this lane to take.
        if (
          compressionFailureKind(result.error) === 'transient' && !isNoCallDeferral(result.error) &&
          result.membrane === ctx.membrane
        ) {
          this.pauseCompressionLane(
            sourceBranch, ctx, result.error, 'l1',
            `the chunk of ${chunk.messages.length} message(s) from ${chunk.messages[0]?.id ?? '?'}`,
            { madeNoCall: true },
          );
        }
        throw result.error;
      }
      // The producer may belong to a different strategy instance. Reload the
      // same namespace's durable result so a successful waiter gets its L1 and
      // an exhausted waiter gets the quarantine projection rather than merely
      // returning after somebody else's work. This instance's kv-unified
      // presentation in flight stays as it is (#166).
      this.takeUpStoreState();
      if (!this.isCompressionBranchCurrent(sourceBranch)) return;
      const coalescedSummary = this.findExactL1(chunkIdKey);
      if (coalescedSummary) {
        // The producer shares this namespace (the in-flight key says so), and
        // its success path has already marked the chunk record and paid off
        // the span's progress and quarantine debt in the shared slots.
        chunk.compressed = true;
        chunk.summaryId = coalescedSummary.id;
        return;
      } else if (this.durableQuarantineFor(this.compressionRefusalQuarantine, quarantineRecord)) {
        // The reload took up the ledger, where the call's family is now
        // quarantined, by the exhaustion of the call this one joined or by a
        // record it found: the gate would skip this request at its next
        // attempt, so this process won't retry it.
        onRequestStopped?.();
        return;
      }
      // Past the checks above, a producer whose strategy was let go of
      // (detached, or reinitialized) left no L1 for this chunk, and the
      // ledger holds no quarantine of its request family. The chunk goes
      // back to tick, which starts it at its next scan through its own gates,
      // from the chunk its table holds then: a rebuild during the wait may
      // have replaced this one or withdrawn it.
      if (result.discarded) onJoinedWorkDiscarded?.();
      return;
    }

    // The warnings for the layout sent: section 1's ownership, the recall
    // cap's, and the pins' fallback. Logged once the compression goes ahead,
    // past the deferral, the quarantine skip and in-flight coalescing, and
    // before it registers as in flight, which the finally below settles.
    if (headCoveredSkipped > 0) {
      this.diag.warn(
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
      }, this.ns);
    }

    if (!sourceOnly && keptSummaries.length < priorSummaries.length) {
      const dropped = priorSummaries.length - keptSummaries.length;
      this.diag.warn(
        `autobio: compression recall-pair budget capped (${keptSummaries.length}/${priorSummaries.length} summaries kept, ` +
          `~${recallTokens} tokens, budget ${recallBudget}` +
          (pinnedRawTokens > 0 ? ` less ~${pinnedRawTokens} of pinned raw` : '') +
          `; ${dropped} oldest dropped this compression).`,
      );
      logCompressionCall({
        event: 'recall-budget-capped',
        site: 'compression',
        kept: keptSummaries.length,
        total: priorSummaries.length,
        tokens: recallTokens,
        budgetTokens: recallBudget,
        ...(pinnedRawTokens > 0 ? { pinnedRawTokens } : {}),
      }, this.ns);
    }

    if (pinsOverBudget) {
      const { history: pinned, requestTokens, contextBudget } = pinsOverBudget;
      // The pins that keep one of those messages raw: a pin whose own bound
      // reads as raw here, over a message the pins keep raw.
      const pinnedRawSet = new Set(pinned.pinnedRaw);
      const forceRawPositions = this.forceRawPinPositions(allMessages);
      const readsBounds = this.readsPinBounds();
      const positionOf = this.positionIndex(allMessages);
      const pins = this.pins.filter((pin) => {
        const own: ResolvedPinBound = pin.level !== undefined ? { level: pin.level }
          : pin.maxLevel !== undefined ? { maxLevel: pin.maxLevel } : 'raw';
        if (readsBounds && !AutobiographicalStrategy.isRawPinBound(own)) return false;
        for (const i of this.pinPositions(pin, positionOf, allMessages) ?? []) {
          if (pinnedRawSet.has(i) && forceRawPositions.has(i)) return true;
        }
        return false;
      }).map((pin) => pin.name ?? pin.id);
      const limit = requestTokens === undefined
        ? `exceeds compressionRecallBudgetTokens (${recallBudget})`
        : `would bring the request to ~${requestTokens} tokens, counting the line a retry adds, over compressionContextBudgetTokens (${contextBudget})`;
      this.diag.warn(
        `autobio: L1 compression of ${chunk.messages.length} message(s) from ${chunkFirstId} recalls the summaries ` +
          `its pins override: the pinned history it would show raw (~${pinned.pinnedRawTokens} tokens in ` +
          `${pinned.pinnedRaw.length} message(s); pins: ${pins.join(', ') || 'none found'}) ${limit}. ` +
          `Unpin them, or narrow a range pin to fewer messages (a pin on any part of a message stored in parts covers the ` +
          `rest of that message too, less a part locked with lockChunk outside the pin's ids), or raise that budget to ` +
          `show them raw here.`,
      );
      logCompressionCall({
        event: 'compression:pinned-raw-over-budget',
        site: 'compression',
        pinnedRawTokens: pinned.pinnedRawTokens,
        pinnedRawMessages: pinned.pinnedRaw.length,
        pins,
        chunk_message_ids: chunk.messages.map((message) => message.id),
        ...(requestTokens === undefined
          ? { limit: 'recall', budgetTokens: recallBudget }
          : { limit: 'context', requestTokens, budgetTokens: contextBudget }),
      }, this.ns);
    }

    let settleInFlight!: (result: CompressionInFlightResult) => void;
    const inFlightCompletion = new Promise<CompressionInFlightResult>((resolve) => {
      settleInFlight = resolve;
    });
    inFlight.set(inFlightKey, inFlightCompletion);

    const callStart = Date.now();
    let logResponse: string | undefined;
    let logError: string | undefined;
    let logWithdrawn = false;
    let logSummaryId: string | undefined;
    const attemptTraces: CompressionAttemptTrace[] = [];
    let successfulTrace: CompressionAttemptTrace | undefined;
    let splitMeta: Record<string, unknown> | undefined;
    let inFlightError: unknown;
    /**
     * Accepted attempt requests by their `requestHash`, so the one that
     * authored the summary can be persisted as a preimage once the
     * disposition gate passes (refused attempts are not mints and are not
     * stored). Usually a reference to a request `request`/`variants` already
     * retain; in the carrier-transport degraded path it is the stripped copy
     * the transport actually took, which nothing else holds. Deliberately NOT
     * hung on the trace objects, which are JSON-serialized into the
     * compression log.
     */
    const attemptRequestsByHash = new Map<string, NormalizedRequest>();
    /** Responses the provider gave for a carrier-stripped copy (runAttempt's
     *  degraded path), whose count is the copy's, not the planned request's. */
    const countedStripped = new WeakSet<object>();
    /** Split-stitch only: the accepted request hash of every fold part, so a
     *  stitched mint persists each leaf's preimage (its own `requestHash` is
     *  a composite over the parts, not a request). */
    let stitchedFoldRequestHashes: string[] | undefined;

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
        attemptRequest = this.prepareCompressionCandidate(attemptRequest, curveLabel);
        // Each attempt, a ladder's next rung included, checks before it calls
        // the provider: a strategy let go of between two attempts starts no
        // further call.
        if (!this.isCompressionBranchCurrent(sourceBranch)) {
          this.logCompressionBranchDiscard(sourceBranch, `${curveLabel}:before_call`, quarantineRecord);
          throw Object.assign(new Error('Compression result crossed a branch boundary'), {
            name: 'CompressionBranchDiscard',
          });
        }
        const started = Date.now();
        let response: unknown;
        // The request the transport ACCEPTED, which is the one that authored
        // whatever comes back. It is `attemptRequest` unless the carrier
        // fallback below fires, in which case the transport REFUSED those
        // bytes and the stripped copy is the authoring request. Everything
        // downstream — trace hash, the accepted-request map, the persisted
        // preimage — keys off this, so a summary's provenance never names a
        // request the model never saw (sol review, 2026-08-24).
        let acceptedRequest = attemptRequest;
        // A call's error, when its work lost its branch or strategy
        // generation while the call was out (a detach, a branch move), is
        // discarded as the call's result would be: no rung counts it, a split
        // part abandons nothing on it, and no second call follows. A host's
        // withdrawal (CompressionWithdrawn) keeps its own path on any branch,
        // as in ladderStep. A cancellation is discarded with the rest, since
        // the generation's end makes one too.
        const discardIfStale = (error: unknown): void => {
          if (isCompressionWithdrawn(error) || this.isCompressionBranchCurrent(sourceBranch)) return;
          this.logCompressionBranchDiscard(sourceBranch, `${curveLabel}:error`, quarantineRecord);
          throw Object.assign(new Error('Compression error crossed a branch boundary'), {
            name: 'CompressionBranchDiscard',
          });
        };
        // The transport's rejection of this exact request's reasoning carriers
        // is a deterministic answer like any rung's, kept under its own
        // identity: a resumed ladder goes straight to the stripped request.
        const carrierLabel = `${curveLabel}:carrier-rejected`;
        const attemptHash = sha256Json(attemptRequest);
        const carrierKnownRejected = knownOutcomes.has(`${carrierLabel}\u0000${attemptHash}`) &&
          requestCarriesReasoning(attemptRequest);
        try {
          if (carrierKnownRejected) {
            throw Object.assign(new Error('carrier rejection known from progress'), { name: 'CompressionKnownCarrierRejection' });
          }
          response = await this.callProvider(ctx.membrane!, attemptRequest);
          // An answer ends its route's pause, on whatever branch.
          this.resumeCompressionLane(ctx.membrane!, this.compressionRequestModel(attemptRequest));
        } catch (error) {
          const known = error instanceof Error && error.name === 'CompressionKnownCarrierRejection';
          if (!known) {
            noteDispatchedModel(error, attemptRequest);
            if (error !== null && typeof error === 'object') dispatchedRequestHash.set(error, attemptHash);
          }
          discardIfStale(error);
          // Degraded mode: the transport rejected the carrier blocks
          // themselves (invalid_request about thinking — never a refusal).
          // Retry this attempt once with text-only recall pairs, loudly. Only a
          // failure classified as a request-attributable rejection qualifies,
          // which a host's withdrawal never is, whatever it carries: a
          // transient one that merely mentions thinking interrupts the ladder.
          if (!known && (
            compressionFailureKind(error) !== 'rejection' ||
            !isCarrierTransportRejection(error) ||
            !requestCarriesReasoning(attemptRequest)
          )) {
            throw error;
          }
          if (!known) {
            noteOutcome({
              curveLabel: carrierLabel,
              requestHash: attemptHash,
              outcome: 'provider_error',
              errorType: compressionErrorType(error) ?? 'invalid_request',
            });
          }
          // The rejection answers the request with its carriers, whose
          // failures ran under the rung's own label: it ends that run, whether
          // it came now or is reused from progress.
          this.endCompressionFailureRun(runSubject, chunkRunKey(runSubject, curveLabel, false));
          this.diag.error(
            `[autobiographical] transport rejected reasoning carriers on '${curveLabel}' ` +
              `(${String(error).slice(0, 200)}) — retrying ONCE with text-only recall pairs (degraded mode)`,
          );
          logCompressionCall({
            event: 'compression:carrier-transport-fallback',
            operation: 'compress_l1',
            metadata: { curveLabel, error: String(error).slice(0, 300) },
          }, this.ns);
          // Stripping removes only blocks and the messages it empties, so the
          // prepared request stays prepared.
          acceptedRequest = stripReasoningFromRequest(attemptRequest);
          try {
            response = await this.callProvider(ctx.membrane!, acceptedRequest);
          } catch (retryError) {
            noteDispatchedModel(retryError, acceptedRequest);
            if (retryError !== null && typeof retryError === 'object') {
              dispatchedRequestHash.set(retryError, sha256Json(acceptedRequest));
            }
            throw retryError;
          }
          if (response && typeof response === 'object') countedStripped.add(response);
          this.resumeCompressionLane(ctx.membrane!, this.compressionRequestModel(acceptedRequest));
        }
        // An answer ends the run of failures of the rung that gave it.
        this.endCompressionFailureRun(runSubject, chunkRunKey(runSubject, curveLabel, acceptedRequest !== attemptRequest));
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
          requestHash: sha256Json(acceptedRequest),
          messageCount: acceptedRequest.messages.length,
          estimatedTokens: this.estimateCompressionRequestTokens(acceptedRequest),
          renderedTokens: this.compressionResponseInputTokens(response),
          stopReason,
          refusalCategory: response && typeof response === 'object'
            ? this.refusalCategory(response as NormalizedResponse)
            : undefined,
          latencyMs: Date.now() - started,
          persisted: false,
        };
        attemptTraces.push(trace);
        attemptRequestsByHash.set(trace.requestHash, acceptedRequest);
        return response;
      };

      // The provider's count of a request the ladder rewrites, its base, only
      // where the provider counted the request as planned. After a carrier
      // rejection the count is the stripped copy's, while the rewrite is built
      // from the request with its carriers and first sent with them, so that
      // base gives no count and admission prices the rewrite by its complete
      // bound (compressionAdmission).
      const baseInputTokens = (counted: unknown): number | undefined =>
        counted && typeof counted === 'object' && countedStripped.has(counted)
          ? undefined
          : this.compressionResponseInputTokens(counted);

      const summariesById = this.persistedCanonicalSummariesById();
      const messagePosition = new Map(allMessages.map((message, index) => [message.id, index]));
      const canonicalLeafIds = keptSummaries.flatMap(
        (summary) => this.recallCurveLeafIds(summary, summariesById, messagePosition) ?? [],
      ).sort((a, b) => (messagePosition.get(a) ?? 0) - (messagePosition.get(b) ?? 0));
      const canonicalCoverageHash = sha256Json(canonicalLeafIds);
      const canonicalRecallIds = keptSummaries.map((summary) => summary.id);
      const canonicalRecallLevels = keptSummaries.map((summary) => summary.level);

      // ---- Durable ladder progress (CompressionFamilyProgress) ----
      // A transient failure spends no rung by itself (a rung its failures
      // decide is a deterministic outcome: CompressionFailureStreak). Every
      // deterministic answer a request in this family has given is kept,
      // written before the next rung's call, so a ladder interrupted by an
      // outage resumes at the interrupted rung without paying again for what
      // it already knows, split-stitch's settled pieces aside (the rung is
      // one unit, re-run whole after a transient failure inside it).
      // Read afresh: another strategy on this store may have advanced it.
      const progress = this.readCompressionFamilyProgress().get(quarantineRecord.familyKey);
      const knownOutcomes = new Map<string, CompressionRefusalOutcomeRecord>();
      for (const known of progress?.outcomes ?? []) {
        knownOutcomes.set(`${known.curveLabel}\u0000${known.requestHash}`, known);
      }
      const progressOutcomes: CompressionRefusalOutcomeRecord[] = [...(progress?.outcomes ?? [])];
      /**
       * The family's exhausted record, which every exit that exhausts it
       * writes: each outcome the family noted, in the order noted (an earlier
       * ladder's answers and carrier rejections among them), and this
       * ladder's admission rejections, which no call answered and progress
       * doesn't keep, where the ladder made them.
       */
      const familyRecord: CompressionRefusalOutcomeRecord[] = [...progressOutcomes];
      let progressCanonicalInputTokens = progress?.canonicalProviderInputTokens;
      // source-only-final's count, the base its hoist is admitted against.
      let progressSourceOnlyInputTokens = progress?.sourceOnlyProviderInputTokens;
      // Whether this family's progress has been in the slot during this
      // ladder: found there when it began, or written by it since.
      let progressSeen = progress !== undefined;
      // A family whose progress was in the slot during this ladder, and is
      // gone from it now, was dropped meanwhile (minted, cleared or swept):
      // this ladder must not bring it back, by a progress write or by an
      // exhaustion. Presence decides for progress the ladder saw, because in
      // this process nothing else writes the family's progress while this
      // ladder runs: only a ladder writes it, and only while its branch is
      // current, and a ladder on the same namespace, branch and family joins
      // this one (compressionInFlight) instead of running. A drop before the
      // ladder first sees its family's progress isn't seen: a mint of the
      // span by another family drops progress by span and finds none of this
      // one's, and this ladder can then write progress, or an exhausted
      // record, for a span that's covered, and the record's one-shot alert
      // goes out with it. That takes sibling strategies with different
      // families over one store. The record stands until the klaxon's
      // paid-off sweep, which runs before it reads, finds the span's chunk
      // compressed or gone, or an operator clears it; the progress sweep
      // drops the progress by its own rule. Across processes nothing
      // coordinates.
      const familyOpen = (): boolean => !progressSeen || this.readCompressionFamilyProgress().has(quarantineRecord.familyKey);
      /** The opt-in compression log's line for an exhaustion, at either exit: the record the ladder wrote. */
      const logExhausted = (): void => logCompressionCall({
        event: 'compression:curve-exhausted',
        operation: 'compress_l1',
        metadata: {
          quarantine_key: quarantineRecord.key,
          model,
          chunk_message_ids: chunk.messages.map((message) => message.id),
          canonical_request_hash: canonicalRequestHash,
          fallback_limit: quarantineRecord.fallbackLimit,
          plan: quarantineRecord.plan,
          outcomes: familyRecord,
        },
      }, this.ns);
      /**
       * What either exhaustion exit does once the family's exhaustion is
       * decided: a family dropped meanwhile is reported; one whose record the
       * ledger now holds, this ladder's or another process's, has its
       * progress forgotten, and tick is told that its request won't go again
       * (onRequestStopped), so tick ends the chunk's runs; and only a record
       * this ladder wrote is logged.
       */
      const settleExhaustion = (exhaustion: 'written' | 'held' | 'dropped' | undefined): void => {
        if (exhaustion === undefined) return;
        if (exhaustion === 'dropped') {
          this.logCompressionFamilyDropped(chunk, quarantineRecord);
          return;
        }
        this.forgetCompressionFamilyProgress((entry) => entry.familyKey === quarantineRecord.familyKey);
        if (exhaustion === 'written') logExhausted();
        onRequestStopped?.();
      };
      const persistProgress = (): void => {
        // The check and the write are synchronous, with no await between them.
        if (!familyOpen()) return;
        this.recordCompressionFamilyProgress(
          sourceBranch, quarantineRecord, progressOutcomes, progressCanonicalInputTokens, progressSourceOnlyInputTokens,
          chunk.messages.map((message) => message.id),
        );
        progressSeen = true;
      };
      /**
       * An answer ends its rung's runs of failures, on both request shapes,
       * whether it came now or is reused from progress: the rung is decided
       * for this family, so no retry of it is coming. Split-stitch's outcome
       * reused from progress (knownSplit) is the one reuse that calls none:
       * the family's exhaustion follows it with no call between, and tick ends
       * the chunk's runs where that exhaustion stops the request.
       */
      const endRungRuns = (curveLabel: string): void => {
        for (const stripped of [false, true]) this.endCompressionFailureRun(runSubject, chunkRunKey(runSubject, curveLabel, stripped));
      };
      /** Keep one deterministic answer; durable before the next rung's call. */
      const noteOutcome = (outcome: CompressionRefusalOutcomeRecord): void => {
        const key = `${outcome.curveLabel}\u0000${outcome.requestHash}`;
        if (knownOutcomes.has(key)) return;
        knownOutcomes.set(key, outcome);
        progressOutcomes.push(outcome);
        familyRecord.push(outcome);
        endRungRuns(outcome.curveLabel);
        persistProgress();
      };
      /**
       * A failure that is not a rejection says nothing about the request by its
       * kind: keep what the ladder has learned and rethrow (the outer catch
       * pauses the lane, and the tick puts the chunk behind the work that
       * hasn't failed). The next eligible tick resumes at this rung. It is
       * evidence about the chunk's rung only by the company it keeps
       * (nextFailureStreak): at COMPRESSION_PERSISTENT_FAILURES, the first and
       * the rest each after other compression landed on the same route and
       * model, the rung is failing on its own, and that becomes its
       * deterministic outcome. A no-call deferral (the caller's provider
       * admission, or the split rung's window) is no failure and counts
       * nothing; the family's progress is still written, as at any
       * interruption.
       */
      const interrupt = (
        error: unknown,
        curveLabel: string,
        requestHash: string,
        streakHash: string = requestHash,
      ): CompressionRefusalOutcomeRecord => {
        if (!isNoCallDeferral(error) && this.isCompressionBranchCurrent(sourceBranch)) {
          // Counted against the request actually dispatched (the stripped one
          // after a carrier rejection is its own run); the outcome at the
          // bound is the rung's.
          const failureClass = compressionFailureClass(error);
          const dispatched = (error !== null && typeof error === 'object' ? dispatchedCompressionModel.get(error) : undefined) ?? model;
          const run = nextFailureStreak(
            this.compressionFailureRuns.get(runSubject)?.run, chunkRunKey(runSubject, curveLabel, streakHash !== requestHash),
            compressionDomain(ctx.membrane!, dispatched), domainLanded(ctx.membrane!, dispatched),
          );
          // The decision is the rung's outcome, which ends its run (noteOutcome).
          if (run.failures >= AutobiographicalStrategy.COMPRESSION_PERSISTENT_FAILURES) {
            return { curveLabel, requestHash, outcome: 'provider_error', errorType: `persistent-${failureClass}` };
          }
          this.compressionFailureRuns.set(runSubject, { run, chunkKey: this.chunkKey(chunk) });
        }
        persistProgress();
        throw error;
      };
      type LadderStep =
        | { kind: 'answered'; response: unknown }
        | { kind: 'decided'; outcome: CompressionRefusalOutcomeRecord; reused: boolean };
      /**
       * One rung's request: reuse its known answer, or call it. A thrown
       * request-attributable rejection becomes the rung's outcome; a transient
       * failure interrupts the ladder; an abort or branch discard propagates.
       */
      const ladderStep = async (
        curveLabel: string,
        requestHash: string,
        call: () => Promise<unknown>,
        // Fields a rejection or a decision is noted with besides its own, such
        // as a recall variant's planned size.
        annotation: Pick<CompressionRefusalOutcomeRecord, 'admittedTokens' | 'budgetTokens'> = {},
      ): Promise<LadderStep> => {
        const known = knownOutcomes.get(`${curveLabel}\u0000${requestHash}`);
        if (known) {
          logCompressionCall({
            event: 'compression:curve-attempt-reused',
            operation: 'compress_l1',
            metadata: { quarantine_key: quarantineRecord.key, curveLabel, requestHash, outcome: known.outcome },
          }, this.ns);
          // Another ladder's answer, perhaps another process's, decided the
          // rung: a run this process opened on it before then ends here.
          endRungRuns(curveLabel);
          return { kind: 'decided', outcome: known, reused: true };
        }
        try {
          return { kind: 'answered', response: await call() };
        } catch (error) {
          if (error instanceof Error && error.name === 'CompressionBranchDiscard') throw error;
          // A host's withdrawal records nothing and propagates as it is, on
          // any branch: the call's own catch discards it on a moved branch
          // and marks its receipts withdrawn.
          if (isCompressionWithdrawn(error)) throw error;
          if (!this.isCompressionBranchCurrent(sourceBranch)) {
            this.logCompressionBranchDiscard(sourceBranch, `${curveLabel}:error`, quarantineRecord);
            throw Object.assign(new Error('Compression error crossed a branch boundary'), {
              name: 'CompressionBranchDiscard',
            });
          }
          const kind = compressionFailureKind(error);
          if (kind === 'abort') throw error;
          const decided: CompressionRefusalOutcomeRecord = kind === 'rejection'
            ? {
                curveLabel,
                requestHash,
                outcome: 'provider_error',
                errorType: compressionErrorType(error) ?? (error instanceof Error ? error.name : typeof error),
              }
            : interrupt(
                error,
                curveLabel,
                requestHash,
                (error !== null && typeof error === 'object' ? dispatchedRequestHash.get(error) : undefined) ?? requestHash,
              );
          const outcome: CompressionRefusalOutcomeRecord = { ...decided, ...annotation };
          noteOutcome(outcome);
          return { kind: 'decided', outcome, reused: false };
        }
      };

      // ---- Canonical stage: the canonical request, then its tool_use retries ----
      let response: unknown;
      let canonicalStopReason: string | undefined;
      /**
       * The canonical stage ended in a deterministic rejection (thrown and
       * request-attributable, or a request its failures decided, see
       * COMPRESSION_PERSISTENT_FAILURES): the same request cannot succeed, so
       * the ladder skips to the one permitted different request,
       * source-only-final, and exhausts if that fails.
       */
      let canonicalRejection: CompressionRefusalOutcomeRecord | undefined;
      /**
       * The canonical-stage rung (canonical, no-tools or tools-less) whose
       * end_turn answer the summary is extracted from, or whose answer is known
       * from progress to have stripped to empty. The plain-prose retry records
       * an empty answer against this rung's own identity, so a resumed ladder
       * reuses it rather than paying for it again.
       */
      let answeredRung: { curveLabel: string; requestHash: string } | undefined;
      const canonicalStep = await ladderStep('canonical', canonicalRequestHash, () => runAttempt(
        request,
        'canonical',
        canonicalRecallIds,
        canonicalRecallLevels,
        canonicalCoverageHash,
      ));
      if (canonicalStep.kind === 'answered') {
        response = canonicalStep.response;
        successfulTrace = attemptTraces[attemptTraces.length - 1];
        canonicalStopReason = this.compressionResponseStopReason(response);
        if (canonicalStopReason === 'end_turn') answeredRung = { curveLabel: 'canonical', requestHash: canonicalRequestHash };
        if (canonicalStopReason !== 'end_turn') {
          progressCanonicalInputTokens = baseInputTokens(response);
          noteOutcome({
            curveLabel: 'canonical',
            requestHash: canonicalRequestHash,
            outcome: canonicalStopReason === 'refusal' ? 'refusal' : 'incomplete',
            ...(canonicalStopReason !== undefined ? { stopReason: canonicalStopReason } : {}),
          });
        }
      } else if (canonicalStep.outcome.outcome === 'provider_error') {
        canonicalRejection = canonicalStep.outcome;
      } else {
        canonicalStopReason = canonicalStep.outcome.stopReason;
        if (canonicalStep.outcome.outcome === 'unusable_empty') {
          answeredRung = { curveLabel: 'canonical', requestHash: canonicalRequestHash };
        }
      }

      // Terminal-disposition gate (2026-08-01): only a complete `end_turn`
      // may proceed toward persistence. A refusal takes the curve-fallback
      // path as before; any OTHER non-end_turn disposition (max_tokens
      // truncation, tool_use, abort, malformed/missing stopReason) rides
      // the same bounded machinery — variants are unlikely to dodge a
      // truncation the way they dodge a classifier, but the path gives us
      // bounded attempts, durable receipts, and quarantine instead of
      // either canonizing an incomplete memory or retrying forever.

      // tool_use is the one non-end_turn disposition the curve variants
      // CANNOT dodge: they vary the recall frontier, not the response mode,
      // so a think-first model fails every variant identically and the chunk
      // quarantines (lena 2026-08-06, L1 site — the merge site had already
      // grown this retry). One immediate canonical retry with the no-tools
      // line, before the curve plan burns its bounded attempts.
      if (canonicalStopReason === 'tool_use' && !canonicalRejection) {
        this.diag.warn(
          `[autobiographical] canonical L1 mint rejected on tool_use — retrying once with no-tools instruction`,
        );
        const noToolsRequest = withNoToolsLine(request);
        const noToolsHash = sha256Json(noToolsRequest);
        const retryStep = await ladderStep('canonical-no-tools', noToolsHash, () => runAttempt(
          noToolsRequest,
          'canonical-no-tools',
          canonicalRecallIds,
          canonicalRecallLevels,
          canonicalCoverageHash,
        ));
        let retryStopReason: string | undefined;
        if (retryStep.kind === 'answered') {
          retryStopReason = this.compressionResponseStopReason(retryStep.response);
          if (retryStopReason === 'end_turn') {
            response = retryStep.response;
            canonicalStopReason = retryStopReason;
            successfulTrace = attemptTraces[attemptTraces.length - 1];
            answeredRung = { curveLabel: 'canonical-no-tools', requestHash: noToolsHash };
          } else {
            noteOutcome({
              curveLabel: 'canonical-no-tools',
              requestHash: noToolsHash,
              outcome: retryStopReason === 'refusal' ? 'refusal' : 'incomplete',
              ...(retryStopReason !== undefined ? { stopReason: retryStopReason } : {}),
            });
          }
        } else if (retryStep.outcome.outcome === 'provider_error') {
          canonicalRejection = retryStep.outcome;
        } else {
          retryStopReason = retryStep.outcome.stopReason;
          if (retryStep.outcome.outcome === 'unusable_empty') {
            // Known from progress: it answered, with nothing usable. Resume at
            // the plain-prose retry, not at this rung.
            canonicalStopReason = 'end_turn';
            answeredRung = { curveLabel: 'canonical-no-tools', requestHash: noToolsHash };
          }
        }
        if (retryStopReason === 'tool_use' && !canonicalRejection) {
          // The span out-pulls the sentence — remove the tools param so a
          // tool call is structurally impossible (see withoutToolsParam).
          this.diag.warn(
            `[autobiographical] no-tools retry also rejected on tool_use — escalating to tools-less request`,
          );
          const toolslessRequest = withoutToolsParam(withNoToolsLine(request));
          const toolslessHash = sha256Json(toolslessRequest);
          const toolslessStep = await ladderStep('canonical-toolless', toolslessHash, () => runAttempt(
            toolslessRequest,
            'canonical-toolless',
            canonicalRecallIds,
            canonicalRecallLevels,
            canonicalCoverageHash,
          ));
          if (toolslessStep.kind === 'answered') {
            const toolslessStop = this.compressionResponseStopReason(toolslessStep.response);
            if (toolslessStop === 'end_turn') {
              response = toolslessStep.response;
              canonicalStopReason = 'end_turn';
              successfulTrace = attemptTraces[attemptTraces.length - 1];
              answeredRung = { curveLabel: 'canonical-toolless', requestHash: toolslessHash };
            } else {
              noteOutcome({
                curveLabel: 'canonical-toolless',
                requestHash: toolslessHash,
                outcome: toolslessStop === 'refusal' ? 'refusal' : 'incomplete',
                ...(toolslessStop !== undefined ? { stopReason: toolslessStop } : {}),
              });
            }
          } else if (toolslessStep.outcome.outcome === 'provider_error') {
            canonicalRejection = toolslessStep.outcome;
          } else if (toolslessStep.outcome.outcome === 'unusable_empty') {
            canonicalStopReason = 'end_turn';
            answeredRung = { curveLabel: 'canonical-toolless', requestHash: toolslessHash };
          }
        }
      }
      if (canonicalStopReason !== 'end_turn') {
        const canonicalOutcome: CompressionAttemptOutcome = canonicalRejection
          ? 'provider_error'
          : canonicalStopReason === 'refusal' ? 'refusal' : 'incomplete';
        const canonicalProviderInputTokens = progressCanonicalInputTokens;
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
          sourceOnlyFallbackRequestHash,
        );
        const canonicalTrace = attemptTraces.find((trace) => trace.curveLabel === 'canonical');
        if (canonicalTrace) canonicalTrace.outcome = canonicalOutcome;
        successfulTrace = undefined;
        logCompressionCall({
          event: canonicalRejection
            ? 'compression:canonical-rejected'
            : canonicalOutcome === 'refusal'
              ? 'compression:canonical-refused'
              : 'compression:canonical-incomplete',
          operation: 'compress_l1',
          metadata: canonicalTrace ?? familyRecord.find((outcome) => CANONICAL_STAGE_LABELS.has(outcome.curveLabel)),
        }, this.ns);
        let fallbackResponse: NormalizedResponse | undefined;

        // One bounded attempt of a tool-prose-hoisted request. Same receipts
        // as the source-only final rung; provider errors never escalate. It
        // is admitted as a recall variant is, against the request it rewrites
        // (`base`), whose answer was a refusal: by the provider's count of
        // that request, as this ladder took it or as the family's progress
        // kept it from an earlier one, or on the hoist's own bound where there
        // is none (compressionAdmission). A rejection is recorded as a
        // variant's is, and nothing is sent.
        const runToolProseRung = async (
          hoistedRequest: NormalizedRequest,
          base: { request: NormalizedRequest; providerInputTokens: number | undefined },
          curveLabel: string,
          recallIds: string[],
          recallLevels: number[],
          coverageHash: string,
        ): Promise<void> => {
          // Hashed as prepared; runAttempt logs what was replaced as it sends it.
          hoistedRequest = this.prepareCompressionAhead(hoistedRequest);
          const requestHash = sha256Json(hoistedRequest);
          const admission = this.compressionAdmission(
            base.request,
            hoistedRequest,
            this.compressionRequestInputBoundTokens(hoistedRequest),
            base.providerInputTokens,
          );
          if (admission.disposition === 'admission_rejected') {
            const trace: CompressionAttemptTrace = {
              curveLabel,
              recallIds,
              recallLevels,
              leafCoverageHash: coverageHash,
              requestHash,
              messageCount: hoistedRequest.messages.length,
              estimatedTokens: this.estimateCompressionRequestTokens(hoistedRequest),
              latencyMs: 0,
              persisted: false,
              outcome: 'admission_rejected',
              admittedTokens: admission.admittedTokens,
              budgetTokens: admission.budgetTokens,
            };
            attemptTraces.push(trace);
            // No call answers it, so progress doesn't keep it; the family's
            // record does, where the ladder made it.
            familyRecord.push({
              curveLabel,
              requestHash,
              outcome: 'admission_rejected',
              admittedTokens: admission.admittedTokens,
              budgetTokens: admission.budgetTokens,
            });
            logCompressionCall({ event: 'compression:curve-attempt', operation: 'compress_l1', metadata: trace }, this.ns);
            return;
          }
          const result = await ladderStep(curveLabel, requestHash, () => runAttempt(
            hoistedRequest, curveLabel, recallIds, recallLevels, coverageHash,
          ));
          if (result.kind === 'decided') return;
          const trace = attemptTraces[attemptTraces.length - 1]!;
          const assessment = this.assessFallbackCompressionResponse(result.response);
          if (assessment.outcome === 'valid') {
            trace.outcome = 'success';
            fallbackResponse = assessment.response;
            response = assessment.response;
            successfulTrace = trace;
          } else {
            trace.outcome = assessment.outcome;
            const outcome: CompressionRefusalOutcomeRecord = {
              curveLabel, requestHash, outcome: assessment.outcome,
              ...(assessment.stopReason !== undefined ? { stopReason: assessment.stopReason } : {}),
              ...(assessment.outcome === 'provider_error' ? { errorType: assessment.errorType } : {}),
            };
            noteOutcome(outcome);
          }
          logCompressionCall({ event: 'compression:curve-attempt', operation: 'compress_l1', metadata: trace }, this.ns);
        };

        // ---- tool-prose hoist rung (compressionToolProseFallback) ----
        // FIRST after a canonical refusal, ahead of the recall variants: the
        // variants vary the recall frontier and cannot dodge a carrier that
        // lives in the chunk's own tool calls, so each would be a burned call
        // (sill 2026-09-19: canonical AND source-only refused on every chunk;
        // 22/22 passed with only this rewrite). Keeps the full canonical
        // context, so a win here costs no voice. Refusal-gated: a truncated or
        // tool_use canonical is not this rung's problem.
        if (canonicalOutcome === 'refusal') {
          const hoistedCanonical = this.toolProseHoistedRequest(request);
          if (hoistedCanonical) {
            await runToolProseRung(
              hoistedCanonical,
              { request, providerInputTokens: canonicalProviderInputTokens },
              'tool-prose-hoist',
              canonicalRecallIds,
              canonicalRecallLevels,
              canonicalCoverageHash,
            );
          }
        }

        // A canonical rejection skips the recall variants: each reuses the
        // canonical's head, middle, chunk, tools, system and config and only
        // expands recall, so it is the same rejected request made larger.
        for (const planned of canonicalRejection ? [] : fallbackPlan) {
          if (fallbackResponse) break;
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
            // No call answers it, so progress doesn't keep it; the family's
            // record does, where the ladder made it.
            familyRecord.push({
              curveLabel,
              requestHash: variant.requestHash,
              outcome: 'admission_rejected',
              admittedTokens,
              budgetTokens: contextBudget,
            });
            logCompressionCall({
              event: 'compression:curve-attempt', operation: 'compress_l1', metadata: trace,
            }, this.ns);
            continue;
          }
          const result = await ladderStep(curveLabel, variant.requestHash, () => runAttempt(
            variant.request,
            curveLabel,
            variantFrontier.map((summary) => summary.id),
            variantFrontier.map((summary) => summary.level),
            variant.leafCoverageHash,
            variant.parent.id,
            variant.children.map((child) => child.id),
          ), { admittedTokens, budgetTokens: contextBudget });
          if (result.kind === 'decided') {
            if (!result.reused) {
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
                ...(result.outcome.errorType !== undefined ? { errorType: result.outcome.errorType } : {}),
                admittedTokens,
                budgetTokens: contextBudget,
              };
              attemptTraces.push(trace);
              logCompressionCall({
                event: 'compression:curve-attempt', operation: 'compress_l1', metadata: trace,
              }, this.ns);
            }
            continue;
          }
          const variantResponse = result.response;
          const trace = attemptTraces[attemptTraces.length - 1]!;
          trace.admittedTokens = admittedTokens;
          trace.budgetTokens = contextBudget;
          logCompressionCall({
            event: 'compression:curve-attempt',
            operation: 'compress_l1',
            metadata: trace,
          }, this.ns);
          const assessment = this.assessFallbackCompressionResponse(variantResponse);
          if (assessment.outcome === 'refusal') {
            trace.outcome = 'refusal';
            const outcome: CompressionRefusalOutcomeRecord = {
              curveLabel,
              requestHash: variant.requestHash,
              outcome: 'refusal',
              stopReason: assessment.stopReason,
              admittedTokens,
              budgetTokens: contextBudget,
            };
            noteOutcome(outcome);
            continue;
          }
          if (assessment.outcome !== 'valid') {
            trace.outcome = assessment.outcome;
            if (assessment.outcome === 'provider_error') trace.errorType = assessment.errorType;
            const outcome: CompressionRefusalOutcomeRecord = {
              curveLabel,
              requestHash: variant.requestHash,
              outcome: assessment.outcome,
              stopReason: assessment.stopReason,
              ...(assessment.outcome === 'provider_error'
                ? { errorType: assessment.errorType }
                : {}),
              admittedTokens,
              budgetTokens: contextBudget,
            };
            noteOutcome(outcome);
            continue;
          }
          trace.outcome = 'success';
          fallbackResponse = assessment.response;
          response = assessment.response;
          successfulTrace = trace;
          break;
        }

        // How the source-only final rung ended, for the hoist below: only a
        // REFUSAL is a carrier problem the rewrite can address. A provider
        // error, a truncated or empty generation is not, and a paid retry on
        // top of one would contradict "provider errors never escalate"
        // (Sol, #106 review: a thrown server_error on source-only-final still
        // bought a fourth call).
        let sourceOnlyOutcome: CompressionAttemptOutcome | 'incomplete' | undefined;
        if (!fallbackResponse && sourceOnlyFallbackRequest) {
          const curveLabel = 'source-only-final';
          const requestHash = sha256Json(sourceOnlyFallbackRequest);
          const result = await ladderStep(curveLabel, requestHash, () => runAttempt(
            sourceOnlyFallbackRequest!, curveLabel, [], [],
            sha256Json(chunk.messages.map((message) => message.id)),
          ));
          if (result.kind === 'decided') {
            sourceOnlyOutcome = result.outcome.outcome;
          } else {
            const trace = attemptTraces[attemptTraces.length - 1]!;
            const assessment = this.assessFallbackCompressionResponse(result.response);
            progressSourceOnlyInputTokens = baseInputTokens(result.response);
            if (assessment.outcome === 'valid') {
              trace.outcome = 'success';
              fallbackResponse = assessment.response;
              response = assessment.response;
              successfulTrace = trace;
            } else {
              sourceOnlyOutcome = assessment.outcome;
              trace.outcome = assessment.outcome;
              const outcome: CompressionRefusalOutcomeRecord = {
                curveLabel, requestHash, outcome: assessment.outcome,
                ...(assessment.stopReason !== undefined ? { stopReason: assessment.stopReason } : {}),
                ...(assessment.outcome === 'provider_error' ? { errorType: assessment.errorType } : {}),
              };
              noteOutcome(outcome);
            }
            logCompressionCall({ event: 'compression:curve-attempt', operation: 'compress_l1', metadata: trace }, this.ns);
          }
        }

        // Source-only final REFUSED too: the same carrier sits in the target
        // chunk itself, so give the source-only shape the same rewrite once.
        // Refusal-gated like the canonical hoist: any other way that attempt
        // ended is not this rung's problem. A canonical rejection allows only
        // source-only-final itself (one extra call at most).
        if (!fallbackResponse && !canonicalRejection && sourceOnlyFallbackRequest && sourceOnlyOutcome === 'refusal') {
          const hoistedSourceOnly = this.toolProseHoistedRequest(sourceOnlyFallbackRequest);
          if (hoistedSourceOnly) {
            await runToolProseRung(
              hoistedSourceOnly,
              { request: sourceOnlyFallbackRequest, providerInputTokens: progressSourceOnlyInputTokens },
              'source-only-tool-prose-hoist',
              [], [],
              sha256Json(chunk.messages.map((message) => message.id)),
            );
          }
        }
        // ---- split-stitch rung (compressionSplitFallback) ----
        // Last rung before quarantine. Observed 2026-09-05 (princess, Bedrock/Sonnet-4.5):
        // chunks refused whole in every presentation while sub-ranges folded cleanly; the
        // mechanism is not established and is not assumed here. The rung folds the chunk
        // in halves at message boundaries (a tool round — tool_use plus every following
        // tool_result message — is indivisible), source-only shape, same instruction and
        // model, and commits ONE L1 over the chunk only if every piece settles. A
        // deterministic rejection of a piece abandons the rung (errors never recurse into
        // smaller calls); a transient failure interrupts it, and the whole rung runs again
        // on a later tick, paying again for the pieces it had settled: it is one atomic
        // retry unit. Bounded by a per-attempt call cap, whose trip is the rung's outcome,
        // and a sliding-window cap scoped to this strategy instance (it resets when the
        // process restarts; it is not a durable quota). The window is a local throttle,
        // not an answer: a rung starts only when the window has room for a whole attempt,
        // and otherwise its chunk waits (CompressionSplitWindowWait). An attempt that alone
        // needs more calls than the window allows can never finish under these caps, so it
        // ends the rung, like the per-attempt cap.
        const splitLeafHash = sha256Json(chunk.messages.map((message) => message.id));
        const knownSplit = knownOutcomes.get(`split-stitch\u0000${splitLeafHash}`);
        if (!fallbackResponse && !canonicalRejection && this.config.compressionSplitFallback === true && sourceOnlyFallbackRequest && knownSplit) {
          // The rung already ended deterministically for this family.
          logCompressionCall({
            event: 'compression:curve-attempt-reused',
            operation: 'compress_l1',
            metadata: { quarantine_key: quarantineRecord.key, curveLabel: 'split-stitch', requestHash: splitLeafHash, outcome: knownSplit.outcome },
          }, this.ns);
        } else if (!fallbackResponse && !canonicalRejection && this.config.compressionSplitFallback === true && sourceOnlyFallbackRequest) {
          const leafHash = splitLeafHash;
          const textOf = (m: { content: ContentBlock[] }): string =>
            m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
          const hasType = (m: { content: ContentBlock[] }, t: string): boolean => m.content.some((blk) => blk.type === t);
          const groupEnd = (i: number): number => {
            let j = i;
            if (hasType(chunk.messages[i], 'tool_use')) {
              while (j + 1 < chunk.messages.length && hasType(chunk.messages[j + 1], 'tool_result')) j++;
            }
            return j;
          };
          const buildSub = (subset: typeof chunk.messages, target: number): NormalizedRequest => {
            const msgs = [
              { participant: 'Context Manager', content: [{ type: 'text', text: COMPRESSION_MARKER }] as ContentBlock[] },
              ...subset.map((m) => ({ participant: m.participant, content: stripThinkingBlocks(m.content) })),
              { participant: 'Context Manager', content: [{ type: 'text', text: this.applyIdentityReminder(this.getCompressionInstruction(chunk, target), this.chunkIsWitnessed(chunk)) }] as ContentBlock[] },
            ];
            const cleaned = stripUnpairedToolBlocks(this.collapseConsecutiveMessages(splitMixedToolMessages(msgs)));
            // runAttempt prepares this request before dispatch and trace hashing.
            return {
              ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
              shedOversizeImages: true,
              messages: cleaned.map((m) => ({ participant: m.participant, content: stripEmptyTextBlocks(m.content) })).filter((m) => m.content.length > 0),
              config: structuredClone(request.config),
              tools: ctx.tools,
            } as NormalizedRequest;
          };
          type SplitPart = { range: [number, number]; kind: 'fold' | 'placeholder'; tokens: number; inputTokens?: number; requestHash?: string; responseContentHash?: string; contentHash: string; text: string };
          // Each part's share of the target is weighed by what it sends,
          // priced as the store prices it, images, tool calls and tool
          // results included: each message as buildSub sends it, thinking
          // stripped, with its serialized media replaced as runAttempt
          // replaces it before dispatch. So a data URL counts as its marker,
          // not as its payload: otherwise the part holding it takes nearly
          // the whole target and its siblings fall to the floor. Each message
          // is stripped once, on a copy.
          const sentTokens = chunk.messages.map((m) => sentTokensOf(m.content));
          const chunkTokens = Math.max(1, sentTokens.reduce((n, c) => n + c, 0));
          const parts: SplitPart[] = [];
          let lastGood: NormalizedResponse | undefined;
          let calls = 0;
          let inputTokens = 0;
          // Logged and persisted whole, so its cache sums appear only once some call has reported them.
          const attempted: { calls: number; refused: number; errors: number; inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number } = { calls: 0, refused: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
          // What the discarded calls (refused, incomplete or empty) reported of the cache.
          const discardedCache = { cacheCreationTokens: 0, cacheReadTokens: 0, seen: false };
          const succ = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheSeen: false };
          const leafModels = new Set<string>();
          let successfulLeaves = 0;
          let modelReportedLeaves = 0;
          const splitStart = Date.now();
          let abortReason: string | undefined;
          const MAX_SPLIT_CALLS = this.config.compressionSplitMaxCallsPerChunk ?? 40;
          const WINDOW_MS = 10 * 60_000;
          const MAX_WINDOW_CALLS = this.config.compressionSplitMaxCallsPer10Min ?? 80;
          const windowStart = Date.now();
          this.splitCallTimes = this.splitCallTimes.filter((t) => windowStart - t < WINDOW_MS);
          // `attempt=false` for the root range: the whole chunk in this shape is
          // source-only-final's request, which gave no summary, so the rung starts by splitting
          // rather than repeating it. Where the chunk is part of a read document their
          // instructions differ: source-only-final takes the reading instruction, and a piece
          // always the compression one.
          const fold = async (a: number, b: number, attempt = true): Promise<boolean> => {
            if (abortReason) return false;
            const subset = chunk.messages.slice(a, b + 1);
            if (attempt) {
            if (calls >= MAX_SPLIT_CALLS) { abortReason = 'chunk-call-cap'; return false; }
            // This attempt alone has used the whole window: under these caps
            // the rung can't finish, which is its outcome, like the per-attempt
            // cap. Otherwise the window is shared with earlier calls (reached
            // only when the per-attempt cap exceeds the window), and the rest
            // of the attempt waits for it like a rung's start.
            if (calls >= MAX_WINDOW_CALLS) { abortReason = 'window-call-cap'; return false; }
            const windowWait = this.splitWindowWait(1, MAX_WINDOW_CALLS, WINDOW_MS);
            if (windowWait) throw windowWait;
            const partTokens = sentTokens.slice(a, b + 1).reduce((n, c) => n + c, 0);
            const target = Math.max(100, Math.round(targetTokens * partTokens / chunkTokens));
            const sub = buildSub(subset, target);
            const label = `split:${a}-${b}`;
            calls++;
            attempted.calls++;
            const slot = Date.now();
            this.splitCallTimes.push(slot);
            let res: unknown;
            try {
              res = await runAttempt(sub, label, [], [], leafHash);
            } catch (error) {
              // A deferral by the caller's provider admission made no call:
              // it takes no window slot and counts as no call. Nor does a
              // host's withdrawal, or its cancellation of the call
              // (compressionFailureKind's 'abort'), which is no outcome of
              // this part either:
              // its slot goes back once its call returns (until then the slot
              // counts), so withdrawn parts don't accumulate in the window. A
              // part sends one call: its request carries no reasoning
              // (buildSub strips the raw thinking and adds no recall pairs), so
              // the carrier fallback never sends a second.
              if (isNoCallDeferral(error) || compressionFailureKind(error) === 'abort') {
                calls--;
                attempted.calls--;
                const at = this.splitCallTimes.lastIndexOf(slot);
                if (at >= 0) this.splitCallTimes.splice(at, 1);
                throw error;
              }
              attempted.errors++;
              if (error instanceof Error && error.name === 'CompressionBranchDiscard') throw error;
              // The rung is one atomic retry unit: a transient failure (or an
              // abort) ends this attempt of it and propagates; only a
              // deterministic rejection of a piece abandons the rung.
              if (compressionFailureKind(error) !== 'rejection') throw error;
              abortReason = `provider-error:${compressionErrorType(error) ?? (error instanceof Error ? error.name : typeof error)}`;
              return false;
            }
            const assessment = this.assessFallbackCompressionResponse(res);
            const trace = attemptTraces[attemptTraces.length - 1]!;
            {
              const r = res as { usage?: { inputTokens?: number; outputTokens?: number }; details?: { usage?: { cacheCreationTokens?: number; cacheReadTokens?: number } } } | undefined;
              const u = r?.usage;
              attempted.inputTokens += u?.inputTokens ?? 0;
              attempted.outputTokens += u?.outputTokens ?? 0;
              // Cache counts are in the response's details, as succ reads them.
              const du = r?.details?.usage;
              const cacheReported = du?.cacheCreationTokens !== undefined || du?.cacheReadTokens !== undefined;
              if (cacheReported) {
                attempted.cacheCreationTokens = (attempted.cacheCreationTokens ?? 0) + (du?.cacheCreationTokens ?? 0);
                attempted.cacheReadTokens = (attempted.cacheReadTokens ?? 0) + (du?.cacheReadTokens ?? 0);
              }
              if (assessment.outcome !== 'valid') {
                attempted.refused++;
                if (cacheReported) {
                  discardedCache.seen = true;
                  discardedCache.cacheCreationTokens += du?.cacheCreationTokens ?? 0;
                  discardedCache.cacheReadTokens += du?.cacheReadTokens ?? 0;
                }
              }
            }
            if (assessment.outcome === 'valid') {
              trace.outcome = 'success';
              lastGood = assessment.response;
              inputTokens += assessment.response.usage?.inputTokens ?? 0;
              {
                const d = assessment.response.details as { usage?: { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number }; model?: { actual?: string; provider?: string } } | undefined;
                succ.inputTokens += assessment.response.usage?.inputTokens ?? 0;
                succ.outputTokens += assessment.response.usage?.outputTokens ?? 0;
                if (d?.usage?.cacheCreationTokens !== undefined || d?.usage?.cacheReadTokens !== undefined) { succ.cacheSeen = true; succ.cacheCreationTokens += d?.usage?.cacheCreationTokens ?? 0; succ.cacheReadTokens += d?.usage?.cacheReadTokens ?? 0; }
                successfulLeaves++;
                if (d?.model?.actual) { modelReportedLeaves++; leafModels.add(`${d.model.actual}|${d.model.provider ?? ''}`); }
              }
              const txt = textOf(assessment.response).trim();
              if (txt.length > 0) {
                parts.push({ range: [a, b], kind: 'fold', tokens: assessment.response.usage?.outputTokens ?? Math.ceil(txt.length / 3), inputTokens: assessment.response.usage?.inputTokens ?? 0, requestHash: trace.requestHash, responseContentHash: sha256Json(assessment.response.content), contentHash: sha256Json(txt), text: txt });
                return true;
              }
            } else {
              trace.outcome = assessment.outcome;
              if (assessment.outcome === 'provider_error') { abortReason = `provider-error:${assessment.errorType ?? 'unclassified'}`; return false; }
            }
            }
            // Refused (or empty): split at a lawful boundary, never inside a tool round.
            if (b > a) {
              const midWish = Math.floor((a + b) / 2);
              const cuts: number[] = [];
              for (let i = a; i < b; i = groupEnd(i) + 1) { const e = groupEnd(i); if (e < b) cuts.push(e); }
              if (cuts.length === 0) return false; // the whole range is one indivisible tool round
              const cut = cuts.reduce((best, c) => (Math.abs(c - midWish) < Math.abs(best - midWish) ? c : best), cuts[0]);
              const left = await fold(a, cut);
              if (!left) return false;
              return fold(cut + 1, b);
            }
            if (this.config.compressionSplitPlaceholder !== true) return false;
            const m = subset[0];
            // Structural author only: the store's participant field, never text that could be quoted or spoofed.
            const who = /^(user|assistant|system)$/i.test(m.participant) ? undefined : m.participant;
            const ph = `[Operator note — not the resident's words: one preserved message${who ? ` from ${who}` : ''} at this point (message id ${m.id}) was not summarized in this entry; its exact source remains in the record.]`;
            parts.push({ range: [a, a], kind: 'placeholder', tokens: Math.ceil(ph.length / 3), contentHash: sha256Json(ph), text: ph });
            return true;
          };
          let complete = false;
          try {
            // A rung starts only when its window has room for a whole attempt.
            // A window of 0 never has room: rather than wait for ever, the
            // rung starts, and its first piece ends it as a cap trip before
            // its call, the outcome of an attempt the caps can never let
            // finish.
            const windowWait = MAX_WINDOW_CALLS > 0
              ? this.splitWindowWait(Math.min(MAX_SPLIT_CALLS, MAX_WINDOW_CALLS), MAX_WINDOW_CALLS, WINDOW_MS)
              : null;
            if (windowWait) throw windowWait;
            complete = await fold(0, chunk.messages.length - 1, false);
          } catch (error) {
            if (error instanceof Error && error.name === 'CompressionBranchDiscard') throw error;
            // The attempt's receipt stands either way.
            this.lastSplitAttempted = { ...attempted, complete: false };
            if (compressionFailureKind(error) === 'abort') throw error;
            // Interrupted, or waiting for the window: the ladder's deterministic
            // answers are kept (not this attempt's settled pieces), and the
            // whole rung runs again on a later tick, its per-attempt caps
            // applying again. When the failures decide the request
            // (COMPRESSION_PERSISTENT_FAILURES), the rung ends here instead.
            const decision = interrupt(error, 'split-stitch', leafHash);
            abortReason = `provider-error:${decision.errorType ?? 'persistent'}`;
          }
          this.lastSplitAttempted = { ...attempted, complete };
          if (complete && lastGood && parts.some((p) => p.kind === 'fold')) {
            // The rung answered. Its pieces end only their own runs, so the
            // run a failure inside the rung opened under its own label ends
            // here, whether or not a summary is written after.
            endRungRuns('split-stitch');
            const stitchedText = parts.map((p) => p.text).join('\n\n');
            const outputTokens = parts.reduce((n, p) => n + p.tokens, 0);
            const contentHash = sha256Json(stitchedText);
            const partsMeta = parts.map(({ text: _text, ...p }) => p);
            const compositeHash = sha256Json({ leafHash, parts: partsMeta.map((p) => ({ range: p.range, kind: p.kind, requestHash: p.requestHash ?? null, responseContentHash: p.responseContentHash ?? null, contentHash: p.contentHash })) });
            const placeholders = parts.filter((p) => p.kind === 'placeholder').map((p) => ({ messageId: chunk.messages[p.range[0]].id, author: 'operator:compressionSplitPlaceholder', text: p.text, contentHash: p.contentHash }));
            const synthetic: NormalizedResponse = {
              content: [{ type: 'text', text: stitchedText }],
              rawAssistantText: stitchedText,
              toolCalls: [],
              toolResults: [],
              stopReason: 'end_turn' as NormalizedResponse['stopReason'],
              usage: { inputTokens, outputTokens },
              // Aggregate over the whole rung, built from true sums only: no optional field
              // (estimatedCost, thinkingTokens, …) is inherited from any single leaf. The model is
              // recorded only when every successful leaf reported the same identity.
              details: {
                stop: { reason: 'end_turn' as NormalizedResponse['stopReason'], wasTruncated: false },
                usage: {
                  inputTokens: succ.inputTokens,
                  outputTokens: succ.outputTokens,
                  ...(succ.cacheSeen ? { cacheCreationTokens: succ.cacheCreationTokens, cacheReadTokens: succ.cacheReadTokens } : {}),
                  // discardedAttempts exists on newer membrane DetailedUsage; older membranes ignore the extra field.
                  discardedAttempts: {
                    attempts: attempted.refused + attempted.errors,
                    inputTokens: Math.max(0, attempted.inputTokens - succ.inputTokens),
                    outputTokens: Math.max(0, attempted.outputTokens - succ.outputTokens),
                    // Present once some discarded call reported cache counts, as the stitched
                    // usage's are once some successful leaf did.
                    ...(discardedCache.seen ? { cacheCreationTokens: discardedCache.cacheCreationTokens, cacheReadTokens: discardedCache.cacheReadTokens } : {}),
                  },
                } as NormalizedResponse['details']['usage'],
                timing: { totalDurationMs: Date.now() - splitStart, attempts: attempted.calls },
                // One identity only when EVERY successful leaf reported one and they all agree;
                // 'mixed' when they disagree or some leaves reported none; 'unknown' when none did.
                model: (leafModels.size === 1 && modelReportedLeaves === successfulLeaves)
                  ? { requested: String((request.config as { model?: string }).model ?? ''), actual: [...leafModels][0].split('|')[0], provider: [...leafModels][0].split('|')[1] }
                  : { requested: String((request.config as { model?: string }).model ?? ''), actual: modelReportedLeaves === 0 ? 'unknown' : 'mixed', provider: modelReportedLeaves === 0 ? 'unknown' : 'mixed' },
                // Aggregate cache view over successful leaves. hitRatio = read / (read + created + uncached
                // input) across those leaves; all zeros when no leaf reported cache accounting.
                cache: { markersInRequest: 0, tokensCreated: succ.cacheCreationTokens, tokensRead: succ.cacheReadTokens, hitRatio: succ.cacheSeen && (succ.cacheReadTokens + succ.cacheCreationTokens + succ.inputTokens) > 0 ? succ.cacheReadTokens / (succ.cacheReadTokens + succ.cacheCreationTokens + succ.inputTokens) : 0 },
              },
              raw: { request: null, response: { stitched: true, compositeHash, contentHash, parts: partsMeta, attempted } },
            };
            this.lastSplitDetails = synthetic.details;
            fallbackResponse = synthetic;
            response = synthetic;
            splitMeta = { by: 'compressionSplitFallback', at: new Date().toISOString(), calls, attempted, leaves: { successful: successfulLeaves, modelReported: modelReportedLeaves, models: [...leafModels] }, compositeHash, contentHash, parts: partsMeta, placeholders };
            stitchedFoldRequestHashes = parts.flatMap((p) => (p.kind === 'fold' && p.requestHash ? [p.requestHash] : []));
            successfulTrace = {
              curveLabel: 'split-stitch', recallIds: [], recallLevels: [], leafCoverageHash: leafHash,
              requestHash: compositeHash, messageCount: chunk.messages.length, estimatedTokens: 0, latencyMs: 0, persisted: false, outcome: 'success', stopReason: 'end_turn',
            };
            this.diag.error(`[autobiographical] split-stitch fold stitched for chunk ${chunk.index}: ${parts.length} part(s), ${placeholders.length} placeholder(s), ${calls} call(s)`);
            logCompressionCall({ event: 'compression:split-stitch', operation: 'compress_l1', metadata: { quarantine_key: quarantineRecord.key, leaf_hash: leafHash, composite_hash: compositeHash, content_hash: contentHash, parts: partsMeta, placeholders, calls, attempted } }, this.ns);
          } else {
            const reason = abortReason ?? 'refused';
            // A provider error, a piece's rejection or the rung's decision,
            // records its bare type, as every other rung's does (a decision's
            // is persistent-<class>, so the quarantine status reads it as
            // one); a cap's trip records the cap.
            const rejectedAs = reason.startsWith('provider-error:') ? reason.slice('provider-error:'.length) : undefined;
            const splitOutcome: CompressionRefusalOutcomeRecord = {
              curveLabel: 'split-stitch',
              requestHash: leafHash,
              outcome: rejectedAs !== undefined ? 'provider_error' : 'refusal',
              ...(abortReason ? { errorType: rejectedAs ?? abortReason } : {}),
            };
            noteOutcome(splitOutcome);
            this.diag.error(`[autobiographical] split-stitch abandoned for chunk ${chunk.index}: ${reason} after ${calls} call(s), ${parts.length} piece(s) discarded (receipts only)`);
            logCompressionCall({ event: 'compression:split-stitch-abandoned', operation: 'compress_l1', metadata: { quarantine_key: quarantineRecord.key, leaf_hash: leafHash, reason, calls, attempted, piecesDiscarded: parts.length } }, this.ns);
          }
        }
        if (!fallbackResponse) {
          if (!this.isCompressionBranchCurrent(sourceBranch)) {
            this.logCompressionBranchDiscard(sourceBranch, 'before_exhaustion', quarantineRecord);
            return;
          }
          const exhaustion = await this.exhaustCompressionRequestFamily(sourceBranch, quarantineRecord, familyRecord, familyOpen);
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          settleExhaustion(exhaustion);
          return;
        }
      }

      // `content` stays text-only (merge inputs, grep, viewers), but the
      // verbatim response blocks — including signed thinking — are captured
      // on the entry: Fable-5/Sonnet-5-class models require the encrypted
      // reasoning returned alongside generated text, and summaries are
      // replayed in the agent's own voice (see captureResponseContent).
      // `response` is absent only when the canonical's answer is known from
      // progress: an end_turn whose text stripped to empty (recorded below
      // before the plain-prose rung was interrupted). It has no text.
      let acceptedResponse = response as NormalizedResponse | undefined;
      const extractSummaryText = (r: NormalizedResponse): string =>
        stripThinkingPreamble(
          r.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text)
            .join('\n'),
        );
      let summaryText = acceptedResponse ? extractSummaryText(acceptedResponse) : '';
      /** The plain-prose rung's own outcome, when it ran (or was known) and gave no memory. */
      let proseOutcome: CompressionRefusalOutcomeRecord | undefined;
      /** The rung whose answer stripped to empty, as recorded before the plain-prose retry. */
      let emptyRung: { curveLabel: string; requestHash: string } | undefined;

      // A generation whose whole text was a literal <thinking> wrapper strips
      // to empty (Opus-3-class habit — see PLAIN_PROSE_RETRY_LINE). The memory
      // content exists; ask once, explicitly, for it as plain prose before
      // giving up. Retry-only: first attempts stay byte-canonical.
      const sourceOnlyFinalWon = successfulTrace?.curveLabel === 'source-only-final';
      // A tool-prose rung follows a refusal: the canonical's, or
      // source-only-final's, which can come after the canonical's incomplete
      // answer. The plain-prose retry below resends the canonical with one
      // more line, which mends neither a refusal nor a truncation, so it
      // would be a burned call.
      const toolProseWonTrace =
        successfulTrace?.curveLabel === 'tool-prose-hoist' ||
        successfulTrace?.curveLabel === 'source-only-tool-prose-hoist'
          ? successfulTrace
          : undefined;
      const proseRequest = withPlainProseLine(request);
      const proseRequestHash = sha256Json(proseRequest);
      if (!summaryText.trim() && !sourceOnlyFinalWon && !toolProseWonTrace) {
        // The canonical answered, but with nothing usable: a deterministic
        // answer like any other, kept so a resumed ladder never pays for it
        // again. The plain-prose retry is then a rung of the same ladder: its
        // known answer is reused, a rejection is its outcome, a transient
        // failure interrupts here and a later tick resumes at it.
        emptyRung = answeredRung
          ?? (successfulTrace ? { curveLabel: successfulTrace.curveLabel, requestHash: successfulTrace.requestHash } : undefined)
          ?? { curveLabel: 'canonical', requestHash: canonicalRequestHash };
        noteOutcome({ ...emptyRung, outcome: 'unusable_empty', stopReason: 'end_turn' });
        this.diag.warn(
          `[autobiographical] L1 summary stripped to empty (thinking-wrapped generation) — retrying once with plain-prose instruction`,
        );
        const proseStep = await ladderStep('canonical-plain-prose', proseRequestHash, () => runAttempt(
          proseRequest,
          'canonical-plain-prose',
          keptSummaries.map((summary) => summary.id),
          keptSummaries.map((summary) => summary.level),
          canonicalCoverageHash,
        ));
        if (proseStep.kind === 'answered') {
          const proseStop = this.compressionResponseStopReason(proseStep.response);
          const proseText = proseStop === 'end_turn' ? extractSummaryText(proseStep.response as NormalizedResponse) : '';
          if (proseText.trim()) {
            acceptedResponse = proseStep.response as NormalizedResponse;
            summaryText = proseText;
            successfulTrace = attemptTraces[attemptTraces.length - 1];
          } else {
            proseOutcome = {
              curveLabel: 'canonical-plain-prose',
              requestHash: proseRequestHash,
              outcome: proseStop === 'end_turn' ? 'unusable_empty' : proseStop === 'refusal' ? 'refusal' : 'incomplete',
              ...(proseStop !== undefined ? { stopReason: proseStop } : {}),
            };
            noteOutcome(proseOutcome);
          }
        } else {
          proseOutcome = proseStep.outcome;
        }
      }

      const responseContent = captureResponseContent(acceptedResponse?.content ?? []);
      logResponse = summaryText;

      // A bugged/empty generation (summarizer returned no text — spent budget on
      // thinking, truncated, etc.) must NOT be stored: recalled later it becomes
      // an empty assistant text block → Anthropic 400 "content must be non-empty".
      // Leave the chunk raw rather than poisoning memory with an empty summary.
      if (!summaryText.trim()) {
        this.diag.warn(`[autobiographical] empty L1 summary for chunk of ${chunk.messages.length} msgs — quarantining (chunk stays raw)`);
        // Durable accounting (cm #55): without it, an all-thinking chunk
        // that survived the prose retry was re-attempted on every
        // maintenance pass forever (canonical + retry per cycle). Same
        // exhaustion path as the refusal curves; the record is sticky by
        // chunk hash and clears via success-clear / sweep / operator.
        if (this.isCompressionBranchCurrent(sourceBranch)) {
          // The empty answers that ended the family, noted beside every
          // answer it was given before them (the canonical stage's among
          // them), so the record keeps them all, each rung once.
          const ended: CompressionRefusalOutcomeRecord[] = toolProseWonTrace
            ? [{
                curveLabel: toolProseWonTrace.curveLabel,
                outcome: 'unusable_empty',
                requestHash: toolProseWonTrace.requestHash,
              }]
            : sourceOnlyFinalWon
            ? [{
                curveLabel: 'source-only-final',
                outcome: 'unusable_empty',
                requestHash: sourceOnlyFallbackRequestHash!,
              }]
            : [
                { ...(emptyRung ?? { curveLabel: 'canonical', requestHash: canonicalRequestHash }), outcome: 'unusable_empty' },
                proseOutcome ?? { curveLabel: 'canonical-plain-prose', outcome: 'unusable_empty', requestHash: proseRequestHash },
              ];
          for (const outcome of ended) noteOutcome(outcome);
          const exhaustion = await this.exhaustCompressionRequestFamily(sourceBranch, quarantineRecord, familyRecord, familyOpen);
          if (this.isCompressionBranchCurrent(sourceBranch)) settleExhaustion(exhaustion);
        }
        return;
      }

      if (!this.isCompressionBranchCurrent(sourceBranch)) {
        this.logCompressionBranchDiscard(sourceBranch, 'before_summary_persist', quarantineRecord);
        return;
      }

      // A compression hold placed while the request was in flight: the
      // summary may be built from provisional content. Discard it; the chunk
      // stays uncompressed and is re-queued when the hold is released.
      if (this.chunkHasHeldMessage(chunk, this.holdBlockedIds(ctx.messageStore))) {
        this.diag.warn('[autobiographical] discarding L1: a compression hold was placed on its span mid-request');
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
          acceptedResponse?.usage?.outputTokens && acceptedResponse.usage.outputTokens > 0
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
        ...(splitMeta ? { stitched: splitMeta } : {}),
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

      // Provenance the auditor can READ: store the accepted request under the
      // hash the entry carries, before the entry itself lands.
      if (successfulTrace && stitchedFoldRequestHashes) {
        // A stitched mint's `requestHash` is a composite over its parts; the
        // requests that authored it are the fold leaves, each accepted through
        // `runAttempt` and readable under the hash its part records.
        for (const foldHash of stitchedFoldRequestHashes) {
          this.persistMintPreimage(ctx, attemptRequestsByHash.get(foldHash), foldHash);
        }
      } else if (successfulTrace) {
        this.persistMintPreimage(
          ctx,
          attemptRequestsByHash.get(successfulTrace.requestHash),
          successfulTrace.requestHash,
        );
      }
      this.pushSummary(entry);
      chunk.compressed = true;
      chunk.summaryId = entry.id;
      this.markChunkRecordCompressed(chunk.recordId, entry.id);
      this._compressionCount++;
      logSummaryId = entry.id;
      // The L1 is pushed and its chunk record marked: it has landed, on the
      // branch that compressed it (noted before the await below, which a
      // branch switch may cross).
      this.noteCompressionLanded(ctx.membrane, model);
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
        }, this.ns);
      }

      // The summary is written. A strategy let go of, or loaded again, while
      // the clear above waited leaves the merge check to the strategy that
      // holds the branch now.
      if (!this.isCompressionBranchCurrent(sourceBranch)) return;
      this.checkMergeThreshold();
    } catch (error) {
      if (error instanceof Error && error.name === 'CompressionBranchDiscard') return;
      // A host's withdrawal isn't a failure: the host asked for it, so its
      // receipts say withdrawn rather than carrying an error, a moved
      // branch's included. On a current branch a coalesced waiter gets it
      // (inFlightError) and rethrows it. On a moved branch the call
      // discards it, as it discards any error, so nothing is rethrown and a
      // waiter resolves.
      if (isCompressionWithdrawn(error)) logWithdrawn = true;
      if (!this.isCompressionBranchCurrent(sourceBranch)) {
        this.logCompressionBranchDiscard(sourceBranch, logWithdrawn ? 'canonical_withdrawn' : 'canonical_error', quarantineRecord);
        return;
      }
      // On work still current, a host's cancellation of a call
      // (compressionFailureKind's 'abort') is a withdrawal too. On a moved
      // branch it was discarded just above with the rest, as the strategy's
      // own cancellation is.
      if (compressionFailureKind(error) === 'abort') logWithdrawn = true;
      if (error instanceof CompressionSplitWindowWait) {
        // Nothing failed: the chunk waits for the split rung's call window.
        this.diag.warn(`[autobiographical] ${error.message}; the chunk from ${chunk.messages[0]?.id ?? '?'} waits ${Math.ceil(error.waitMs / 1000)} s`);
        logError = boundFailureLogText(error.message);
        inFlightError = error;
        throw error;
      }
      // A host's withdrawal or cancellation is no failure: its receipt says
      // withdrawn, and the lane doesn't pause.
      if (!logWithdrawn) {
        this.diag.error(`Failed to compress chunk (hierarchical): ${describeCompressionFailure(error)}`);
        // A failure that says nothing about the request pauses the lane; the
        // chunk goes behind the work that hasn't failed, and its family keeps
        // its progress.
        if (compressionFailureKind(error) === 'transient') {
          this.pauseCompressionLane(
            sourceBranch, ctx, error, 'l1',
            `the chunk of ${chunk.messages.length} message(s) from ${chunk.messages[0]?.id ?? '?'}`,
          );
        }
        logError = boundFailureLogText(error instanceof Error ? error.message : String(error));
      }
      inFlightError = error;
      throw error;
    } finally {
      settleInFlight({
        ...(inFlightError !== undefined ? { error: inFlightError, membrane: ctx.membrane } : {}),
        ...(inFlightError === undefined && this.compressionBranchGeneration !== sourceBranch.strategyGeneration
          ? { discarded: true }
          : {}),
      });
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
        }, this.ns);
      }
      logCompressionCall({
        operation: 'compress_l1',
        // The DISPATCHED bytes, read off the request object — deliberately
        // NOT ctx.systemPrompt again. This finally runs after an awaited
        // round trip and that getter is live, so a host activation landing
        // mid-flight would make this receipt name a prompt the call never
        // sent. Every rung that can actually reach the wire from here
        // (withAppendedInstruction, withoutToolsParam,
        // stripReasoningFromRequest) derives from `request` by spread, and the
        // recall-curve variants from `authoredRequest`, its unprepared form;
        // each leaves `system` untouched, as preparation does, so the
        // canonical request's field is the sent value for all of them. Null
        // when the request carried no system field, so the pre-threading log
        // shape is preserved exactly; summarized (not verbatim) when it did,
        // matching how `messages` is logged. `messages` summarizes the
        // prepared canonical request.
        system: request.system ? summarizeTelemetryText(request.system) : null,
        messages: summarizeTelemetryMessages(request.messages),
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
          ...(logWithdrawn ? { withdrawn: true } : {}),
        },
        response: summarizeTelemetryText(logResponse),
        error: logError,
      }, this.ns);
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
   * live source positions are not exactly adjacent (a hole containing
   * record-owned material is a different representation and cannot be folded
   * into this parent); exclude candidates whose OWN span exceeds the
   * level-scaled `mergeMaxSourceSpanMessages` limit (replay-era wide-span
   * summaries would bridge anything they join); merge the oldest run that
   * still has `threshold` members.
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
    this.diag.warn(`[autobiographical] merge-candidate excluded: ${detail}`);
  }

  /**
   * The message spans of work the lane put back after a failure and will try
   * again, each with the level of the summary its answer makes: a pending
   * chunk with a run of failures in progress (an L1), and a queued merge with
   * one (see nextFailureStreak; a summary of the merge's level). A hole such
   * a span covers in a run of summaries of that level or above is not
   * stranded, since a summary will fill it. Below that level a merge's span
   * is its own sources, which its summary leaves in place, so it fills no
   * hole there.
   *
   * Runs live in the process, so after a restart a hole over a chunk that
   * failed before it holds nothing until the chunk's next attempt (a failure
   * starts a run again, and an answer fills the hole), and the merge check
   * at open can consolidate the interior run before it at two: a lopsided
   * merge, with nothing lost. Coverage stays with runs rather than every
   * pending chunk: a chunk the lane won't attempt, such as a held one (tick
   * ends its scan there), would keep the run before it waiting for as long as
   * it waits, the stranding the newest-run rule in contiguousMergeCandidates
   * exists to prevent. For the same reason a chunk's runs end where this
   * process won't retry its request (endChunkFailureRuns).
   */
  private pendingRetrySpans(messageOrder: Map<MessageId, number>): Array<[number, number, number]> {
    const spans: Array<[number, number, number]> = [];
    const addSpan = (ids: readonly string[], level: number): void => {
      let first = Infinity;
      let last = -Infinity;
      for (const id of ids) {
        const position = messageOrder.get(id);
        if (position === undefined) continue;
        first = Math.min(first, position);
        last = Math.max(last, position);
      }
      if (first <= last) spans.push([first, last, level]);
    };
    // A run holds a span only while its chunk is still pending: a chunk that
    // a rebuild re-cut is no live chunk, and no retry will fill its span.
    let pendingByKey: Map<string, Chunk> | undefined;
    for (const { chunkKey } of this.compressionFailureRuns.values()) {
      pendingByKey ??= new Map(this.chunks.filter((chunk) => !chunk.compressed).map((chunk) => [this.chunkKey(chunk), chunk]));
      const chunk = pendingByKey.get(chunkKey);
      if (chunk) addSpan(chunk.messages.map((message) => message.id), 1);
    }
    for (const merge of this.mergeQueue) {
      if (!this.mergeFailureRuns.has(mergeFailureKey(merge))) continue;
      addSpan(merge.sourceIds.flatMap((id) => {
        const source = this.summaryById(id);
        return source ? [source.sourceRange.first, source.sourceRange.last] : [];
      }), merge.level);
    }
    return spans;
  }

  protected contiguousMergeCandidates(
    unmerged: SummaryEntry[],
    threshold: number,
  ): SummaryEntry[] | null {
    if (unmerged.length < threshold) return null;
    // Store order, not chunk-record order: a chunk minted late over an early
    // message (issue #122's head ratchet) is adjacent to the frontier in
    // record order and to the chronicle's opening in store order.
    const messageOrder = this.mergePositionIndex();
    const spanBase = this.config.mergeMaxSourceSpanMessages ?? 1500;
    const mergeK = this.config.mergeThreshold ?? 6;
    const withPos: Array<{ s: SummaryEntry; first: number; last: number }> = [];
    // Held summaries (mergeHeldSourceIds: operator holds, and the sources a
    // merge-quarantine record holds out) leave a hole: the runs split there
    // and merge on each side, while the klaxon names a quarantined merge's
    // record and the debt report lists operator holds. `heldEnd` is the last
    // position a held summary reaches: a run that ends before it can't grow
    // past the hole.
    const held = this.mergeHeldSourceIds(messageOrder);
    let heldEnd = -Infinity;
    const heldFirsts: number[] = [];
    for (const s of unmerged) {
      const first = messageOrder.get(s.sourceRange.first);
      const last = messageOrder.get(s.sourceRange.last);
      if (first === undefined || last === undefined) {
        // Pruned/missing source messages: the candidate can NEVER merge.
        // This was a silent drop (rev-5 review: "frontier debt, no log").
        this.warnMergeExclusion(
          s.id,
          `L${s.level} ${s.id}: source position unresolved (pruned or hidden source messages?) — permanently unmergeable, frontier debt`,
        );
        continue;
      }
      if (held.has(s.id)) {
        heldEnd = Math.max(heldEnd, first, last);
        heldFirsts.push(Math.min(first, last));
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

    // Split into strictly contiguous live runs. Deleted messages do not occupy
    // positions in `messageOrder`, so this still bridges true tombstones; a
    // run splits wherever a listed message stands between two sources, owned
    // by another summary or by none (mergePositionIndex). A hole that
    // work put back after a failure will fill at this level (pendingRetrySpans)
    // isn't stranded: the run before it waits, as the newest run does. A run
    // can grow only up to the next run or the first held summary after it,
    // whichever comes first, so it waits only for a retry pending before that.
    let retrySpans: Array<[number, number, number]> | undefined;
    const retryPendingIn = (from: number, to: number, level: number): boolean => {
      retrySpans ??= this.pendingRetrySpans(messageOrder);
      return retrySpans.some(([first, last, filled]) => filled <= level && first <= to && last >= from);
    };
    heldFirsts.sort((a, b) => a - b);
    const waitsFor = (end: number, next: number, level: number): boolean => {
      const bound = Math.min(next, heldFirsts.find((p) => p > end) ?? Infinity) - 1;
      return bound > end && retryPendingIn(end + 1, bound, level);
    };
    const runs: Array<typeof withPos> = [];
    const waiting: boolean[] = [];
    let run: typeof withPos = [];
    let runEnd = -Infinity;
    for (const x of withPos) {
      if (run.length > 0 && x.first !== runEnd + 1) {
        runs.push(run);
        waiting.push(waitsFor(runEnd, x.first, x.s.level ?? 1));
        run = [];
        runEnd = -Infinity;
      }
      run.push(x);
      runEnd = Math.max(runEnd, x.last);
    }
    if (run.length > 0) {
      runs.push(run);
      // The newest run waits for no retry, unless a held summary follows it.
      waiting.push(heldEnd > runEnd && waitsFor(runEnd, Infinity, run[0]!.s.level ?? 1));
    }
    if (runs.length === 0) return null;
    // A run that ends before a held summary can't grow past the hole, so it
    // isn't the newest: an empty run after it keeps it interior, and it
    // consolidates at two as an interior run does. `runEnd` is still the last
    // run's end.
    if (heldEnd > runEnd) runs.push([]);

    // ONLY THE NEWEST RUN CAN GROW (2026-07-12 starvation fix). Summaries are
    // produced at the live end, so an INTERIOR run is stranded: it can never
    // reach `threshold` members, and waiting for it froze the whole pyramid
    // (mythos: L1 frontier [913-981]x5 + [4039-4131]x5 separated by a
    // 3058-message hole from the poison-node surgery — 10 unmerged L1s, 8
    // unmerged L2s, merge queue empty, fold floor climbing to 117k until the
    // picker died). Interior runs consolidate as soon as they have 2 members;
    // only the newest run waits for the full threshold. The one exception is
    // a run whose hole a retry will fill: work put back after a failure is
    // produced behind the live end, so the run before it is not stranded and
    // waits too, rather than merging lopsided before the summary lands. Once
    // that work is minted its hole is filled, and once its request is
    // quarantined the hole is stranded until a later request shape or a
    // clear lands it, and the rule above applies. Past the speculative cap
    // the run waits as below it: the cap holds L1 production only while an
    // L1 merge is queued to bring the count back down (speculativeCapHolds),
    // so the retry that fills the hole comes once the count is back under
    // the cap or no L1 merge is left queued.
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      const isNewest = i === runs.length - 1;
      if (r.length >= threshold) return r.slice(0, threshold).map((x) => x.s);
      if (!isNewest && !waiting[i] && r.length >= 2) return r.slice(0, threshold).map((x) => x.s);
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
   *
   * Resolves true when it wrote the merged parent. It resolves false, having
   * written nothing, when it skips the entry with no call (a source missing,
   * already parented or held out of merges, or a crossed merge refused), when
   * its branch went stale during the call, or when its sources were parented
   * while the call was out. tick drops a skipped entry from the queue unless
   * the skip dropped it already, as a refused crossed merge and an entry
   * holding a held source do, or replaced the queue with the store's, as one
   * that took up another instance's state does: a later tick then drops
   * the entry from that queue, if it holds it. Any answer
   * from the provider resumes the lane, a refusal included, but only a
   * written merge is a landing (noteCompressionLanded). A hold placed on the
   * span during the call keeps a valid answer out (MergeHoldDiscard).
   */
  protected async executeMerge(
    targetLevel: SummaryLevel,
    sourceIds: string[],
    ctx: StrategyContext
  ): Promise<boolean> {
    const sourceBranch = this.requireLoadedBranch('executeMerge');
    if (!ctx.membrane) {
      throw new Error('No membrane instance for merge');
    }

    const sources = sourceIds
      .map(id => this.summaries.find(s => s.id === id))
      .filter((s): s is SummaryEntry => s != null);

    if (sources.length !== sourceIds.length) {
      this.diag.warn('executeMerge: some source summaries not found, skipping');
      return false;
    }

    // A queued merge may become stale after another worker/earlier queue item
    // parents only SOME of its sources. Reparenting the whole list in that
    // state rewrites the authored child graph and creates crossed lineages
    // (Fable's L2-37/L2-43 scar). Any parented source invalidates this queue
    // item; the remaining orphans will be regrouped by the next threshold
    // pass. Never mutate an already-authored parent edge. The store's
    // summaries are read too, so a merge another instance sharing the store
    // has written is taken up here, before any call.
    const alreadyParented = this.parentedMergeSources(sources);
    if (alreadyParented.length > 0) {
      this.diag.warn(
        `executeMerge: ${alreadyParented.length}/${sources.length} source(s) already parented ` +
          `(${alreadyParented.join(', ')}); skipping stale queue entry`,
      );
      return false;
    }

    // A held source (mergeHeldSourceIds: an operator hold, or a source a
    // merge-quarantine record holds out of merges) invalidates the entry the
    // same way: it was queued before the hold, as a queue from an older
    // version, one persisted before an operator hold was set, or a direct
    // caller's overlapping group can be. A holding record's own group is
    // retried only by clearMergeQuarantine, which deletes the record first.
    this.refreshStoreOrder(ctx.messageStore.getAll());
    const position = this.mergePositionIndex();
    const held = this.mergeHeldSourceIds(position);
    const heldSources = sources.filter((source) => held.has(source.id));
    if (heldSources.length > 0) {
      this.diag.warn(
        `executeMerge: ${heldSources.length}/${sources.length} source(s) held out of merges ` +
          `(${heldSources.map((source) => source.id).join(', ')}); skipping stale queue entry`,
      );
      // The merge check left the entry's other sources out while it was
      // queued: drop it now and offer them, as refuseCrossedMerge does.
      const head = this.mergeQueue[0];
      if (head && head.sourceIds === sourceIds) this.dequeueMerge();
      this.checkMergeThreshold();
      return false;
    }

    // Last line of defence: a crossed node is never minted. Whatever enqueued
    // this group (threshold pass, demand path, a persisted queue from an older
    // grammar, an operator), the sources must be one level below the target
    // and strictly adjacent in store order, with no listed message between
    // them (mergePositionIndex).
    const topology = this.mergeTopologyProblem(targetLevel, sources, position);
    if (topology) {
      this.refuseCrossedMerge(targetLevel, sourceIds, topology);
      return false;
    }

    const targetTokens = this.config.summaryTargetTokens ?? 2000;
    const participant = this.config.summaryParticipant ?? 'Claude';
    const mergeAttempts =
      this.mergeQueue[0]?.sourceIds === sourceIds ? (this.mergeQueue[0]?.attempts ?? 0) : 0;
    const mergeAttemptLimit = Math.max(1, this.config.mergeAttemptLimit ?? 5);
    const mergeSourceOnly = this.config.compressionMergeSourceOnly === true ||
      (this.config.compressionMergeSourceOnlyFallback === true &&
        mergeAttempts >= mergeAttemptLimit - 1);

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
    // ready, so nothing after that is visible, except what a recalled
    // summary's own text carries: one written before this as-of rule may
    // say what came after its history.
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

    // The merge range's start in the store: its first leaf still there
    // (startInStore), as a summary's start is read (summaryStartInStore). -1
    // only when none is: nothing in the store says when that history
    // happened, so the merge gets no head (headAsOf) and recalls no summary
    // (1a), as a compression chunk in that state does.
    const positionOf = this.positionIndex(allMessages);
    const mergeStartIdx = this.startInStore(sourceLeafIds, positionOf);

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
    const priorStart = new Map<string, number>();
    const priorSummariesAll = this.summaries
      // Skip empty-content summaries (see compressChunkHierarchical): an empty
      // text block in the merge recall header 400s and stalls compression.
      .filter((s) => !s.mergedInto && !!s.content && s.content.trim().length > 0)
      .filter((s) => {
        for (const lid of s.sourceIds) if (sourceLeafIds.has(lid)) return false;
        // Where it starts (summaryStartInStore): a summary whose first message
        // a host removed starts at its first message still in the store, so
        // it's recalled and its other messages, which its coverage holds out
        // of the raw middle, keep a form here. One with none left isn't.
        const firstIdx = this.summaryStartInStore(s, positionOf, summariesById);
        priorStart.set(s.id, firstIdx);
        return firstIdx >= 0 && firstIdx < mergeStartIdx;
      })
      .sort((a, b) => priorStart.get(a.id)! - priorStart.get(b.id)!);

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
    // The head window is the foundational identity anchor — the opening
    // the merged history followed (headAsOf: the chronicle's opening, or
    // after a head-window reset the opening of its topic). It establishes
    // who is speaking to whom. Without it, when the merge target's content
    // is heavily first-person
    // from someone other than the agent, the agent loses its first-person
    // grounding and drifts into the content author's voice.
    //
    // ONE-TO-ONE INVARIANT (see compressChunkHierarchical): ownership
    // wins over the token-derived head boundary. A head-range message
    // covered by a live summary renders via its recall pair; one inside
    // the merge tree renders in the TARGET expansion. Never raw here too.
    // The head as of the merge's first message (headAsOf), as for an L1: a
    // merge over history from before a head-window reset is given the head
    // that history followed. Clipped at a hold there, as before.
    const { start: headStartIdx, end: headEndIdx } = this.headAsOf(ctx.messageStore, mergeStartIdx);
    let headCoveredSkipped = 0;
    for (let i = headStartIdx; !mergeSourceOnly && i < headEndIdx && i < allMessages.length; i++) {
      const m = allMessages[i];
      if (priorSummaryMessageIds.has(m.id) || sourceLeafIds.has(m.id)) {
        headCoveredSkipped++;
        continue;
      }
      llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
    }
    if (headCoveredSkipped > 0) {
      this.diag.warn(
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
      }, this.ns);
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
    const configuredRecallBudget = mergeSourceOnly ? 0 : (this.config.compressionRecallBudgetTokens ?? 100_000);
    const mergeRecallBudget = mergeSourceOnly ? 0 : Math.max(
      8_000,
      Math.round(configuredRecallBudget * 0.5 ** Math.min(mergeAttempts, 4)),
    );
    if (mergeRecallBudget < configuredRecallBudget) {
      this.diag.warn(
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
      this.diag.warn(
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
      }, this.ns);
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
    if (mergeStartIdx >= 0 && !mergeSourceOnly) {
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
      this.diag.warn(
        `[autobiographical] L${targetLevel} merge retry after refusal rejection — ` +
          `source-level fallback payload (sources shown as recall pairs, no deeper expansion)`,
      );
      logCompressionCall({
        event: 'merge-refusal-fallback',
        site: 'merge',
        targetLevel,
        sources: sourceIds,
      }, this.ns);
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
      const body = this.shardedBodyOf(sourceLeafIds, allMessages, ctx);
      if (body) mergeReadingContext = { totalTokens: body.totalTokens };
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
      // Only a merge whose every source is witnessed takes the witnessed
      // reminder. A mixed merge takes the live instruction and reminder, and
      // its request shows inherited and lived material together, with no
      // label saying which is which. The sources' witnessed stamps decide
      // this predicate and the new summary's stamp, and the request never
      // shows them. Outside a refusal fallback they choose the merge
      // instruction only through getMergeInstruction: reading mode's
      // instruction has no witnessed variant, and an override that doesn't
      // read them, such as KnowledgeStrategy's, keeps its own. A refusal
      // fallback calls the base formatters directly, so there they choose it
      // whatever the mode or the override.
      sources.length > 0 && sources.every((s) => s.witnessed),
    );
    if (mergeSourceOnly) {
      mergeInstructionText += '\n\nAttribution discipline: preserve who made each claim. Do not turn another participant’s diagnosis, promise, operational status, or forecast into your own first-person fact unless the source includes your own direct confirmation. Preserve corrections and uncertainty explicitly.';
    }
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
      this.diag.warn(
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
      this.diag.warn(
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

    // Same bundled-tool-cycle defense as compressChunkHierarchical, after the
    // same separation of recall answers from the agent's raw turns: an L2
    // target, or the raw middle, follows the last ladder answer.
    const split = splitMixedToolMessages(this.separateRecallAnswers(llmMessages));
    const collapsed = this.collapseConsecutiveMessages(split);
    const cleaned = stripUnpairedToolBlocks(collapsed);

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

    // The HOST's system prompt, or none — same rationale as
    // compressChunkHierarchical, including the currency caveat spelled out
    // there: the threaded value is the host's LATEST, so this merge is
    // governed by the current identity policy, not by whatever was served
    // when the source summaries were authored. Undeclared, identity is
    // established by the head window (present at the start of llmMessages
    // above) and by the prior recall pairs. Declared, it is the identity
    // this merge is authored under — and a merge re-summarizes summaries,
    // so an omission here compounds upward through every level of the
    // pyramid.
    const request: NormalizedRequest = {
      // Served FIRST, ahead of the head — the live activation's own layout
      // (system prompt -> head -> middle). Conditionally spread rather than
      // assigned: an undeclared prompt must leave the request shape and its
      // request hash byte-identical to what they were before this field
      // existed.
      ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
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
    const dispatchRequest = this.prepareCompressionCandidate(
      toollessEscalation ? withoutToolsParam(request) : request, `merge-l${targetLevel}`,
    );
    if (toollessEscalation) {
      this.diag.warn(
        `[autobiographical] L${targetLevel} merge retry ${this.mergeQueue[0]?.attempts} — escalating to tools-less request`,
      );
    }

    const callStart = Date.now();
    let logResponse: string | undefined;
    let logError: string | undefined;
    let logWithdrawn = false;
    let logNewSummaryId: string | undefined;
    // The request last sent: `dispatchRequest`, or after a carrier
    // rejection its copy with the reasoning stripped. When the call
    // succeeds it is the request the transport accepted, which authored the
    // merge. See the L1 ladder's `acceptedRequest` (sol review, 2026-08-24).
    let acceptedRequest = dispatchRequest;
    // As in the L1 ladder, a call's error on work that lost its currency is
    // discarded as its result would be: the merge returns quietly, and makes
    // no second call. A host's withdrawal (CompressionWithdrawn) keeps its own
    // path on any branch; a cancellation is discarded with the rest, since
    // the generation's end makes one too.
    const stale = (error: unknown): boolean =>
      !isCompressionWithdrawn(error) && !this.isCompressionBranchCurrent(sourceBranch);
    // Preparing the request can run a subclass's prepareCompressionRequest(),
    // so the currency is checked again just before the call, as each L1
    // attempt checks it: a generation ended there makes no call.
    if (!this.isCompressionBranchCurrent(sourceBranch)) return false;

    try {
      let response: NormalizedResponse;
      try {
        response = await this.callProvider(ctx.membrane, dispatchRequest);
      } catch (error) {
        noteDispatchedModel(error, dispatchRequest);
        // An error on work that lost its currency is discarded as its result
        // would be, before the carrier fallback: no second call follows.
        if (stale(error)) return false;
        // Same degraded-mode fallback as the L1 ladder: transport rejected
        // the carrier blocks → retry once text-only, loudly. Only a failure
        // classified as a request-attributable rejection qualifies, which a
        // host's withdrawal never is, whatever it carries.
        if (
          compressionFailureKind(error) !== 'rejection' ||
          !isCarrierTransportRejection(error) ||
          !requestCarriesReasoning(dispatchRequest)
        ) throw error;
        this.diag.error(
          `[autobiographical] transport rejected reasoning carriers on L${targetLevel} merge ` +
            `(${String(error).slice(0, 200)}) — retrying ONCE with text-only recall pairs (degraded mode)`,
        );
        logCompressionCall({
          event: 'compression:carrier-transport-fallback',
          operation: `merge_l${targetLevel}`,
          metadata: { error: String(error).slice(0, 300) },
        }, this.ns);
        // Stripping removes only blocks and the messages it empties, so the
        // prepared request stays prepared.
        acceptedRequest = stripReasoningFromRequest(dispatchRequest);
        try {
          response = await this.callProvider(ctx.membrane, acceptedRequest);
        } catch (retryError) {
          noteDispatchedModel(retryError, acceptedRequest);
          if (stale(retryError)) return false;
          throw retryError;
        }
      }
      // Any answer from the provider ends its route's pause and backoff,
      // whatever the disposition gate below makes of it (a refusal included),
      // and on whatever branch: the pause is the route's, not the branch's.
      this.resumeCompressionLane(ctx.membrane, this.compressionRequestModel(acceptedRequest));
      // Request identity — persisted on the authored summary (provenance) and
      // stamped on every failure receipt, so any parent can be traced back to
      // the request that authored it: sha256 of the accepted request's JSON,
      // which is also the blob key its persisted preimage lives under (see
      // src/mint-preimage.ts). Computed AFTER dispatch because only then is
      // the accepted request known.
      const requestHash = sha256Json(acceptedRequest);
      if (!this.isCompressionBranchCurrent(sourceBranch)) return false;

      // A summary has one parent, so the check at entry is made again here,
      // after the call: while the call was out, another merge of these
      // sources may have been written, by another instance sharing the store
      // (taken up here, as at entry) or by any other path that brings two
      // merges of one group together. This one writes nothing, and its queue
      // entry goes as a finished merge's does. Where this instance took up
      // the store's state, the store's queue has replaced its own, and an
      // entry for these sources still in it goes when a later tick reaches
      // it and the entry check finds them parented. Nothing below awaits
      // before the writes.
      const parentedSince = this.parentedMergeSources(sources);
      if (parentedSince.length > 0) {
        this.diag.warn(
          `executeMerge: ${parentedSince.length}/${sources.length} source(s) parented while the L${targetLevel} ` +
            `merge's call was out (${parentedSince.join(', ')}); its summary is not written`,
        );
        return false;
      }

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
        this.diag.warn(
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
        }, this.ns);
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
        this.diag.warn(
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

      // Hold placed mid-request: the answer is kept out, and the merge stays
      // queued and runs after the release (see MergeHoldDiscard).
      if (this.mergeBlockedByHold(sourceIds, ctx.messageStore)) {
        throw new MergeHoldDiscard(`merge ${newEntry.id} discarded: a compression hold was placed on its span mid-request`);
      }

      // Provenance the auditor can READ: store the accepted request under the
      // hash the entry carries, before the entry itself lands.
      this.persistMintPreimage(ctx, acceptedRequest, requestHash);

      // Append the new merged entry first, then mark sources. Persist each
      // mergedInto edit individually so chronicle reflects the same shape as
      // the in-memory mirror. (If the process crashes mid-loop, restart sees
      // the new entry plus a partial set of marked sources, and the open makes
      // the new entry the parent of each unmarked one, as the one summary a
      // level up that lists it, unless another instance's merge lists it too:
      // see loadPersistedState.)
      this.pushSummary(newEntry);

      for (const source of sources) {
        this.setMergedInto(source, newEntry.id);
      }

      // Check if this merge triggers a further merge
      this.checkMergeThreshold();
      return true;
    } catch (error) {
      // A host's withdrawal, or its cancellation of the call, is no failure:
      // it logs nothing, and its receipt says withdrawn rather than carrying
      // an error.
      const withdrawn = compressionFailureKind(error) === 'abort';
      // Disposition rejections already warned + receipted above — don't
      // double-log them as crashes; tick() consumes them for retry policy.
      if (error instanceof MergeHoldDiscard) {
        this.diag.warn(`[autobiographical] ${error.message}; the merge stays queued until the hold is released`);
      } else if (!(error instanceof MergeDispositionRejection) && !withdrawn) {
        this.diag.error(`Failed to merge summaries into L${targetLevel}: ${describeCompressionFailure(error)}`);
      }
      if (withdrawn) logWithdrawn = true;
      else logError = boundFailureLogText(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      logCompressionCall({
        operation: `merge_l${targetLevel}`,
        // The DISPATCHED bytes — see the twin note at the compress_l1 site
        // for why this must not re-read ctx.systemPrompt after the await.
        // `acceptedRequest` is the request last sent: `request` prepared, or
        // its tools-less escalation prepared, or, after a carrier rejection,
        // either with its reasoning stripped, which the transport accepted
        // unless that retry threw too. Each carries `system` through by
        // spread, as preparation does.
        system: acceptedRequest.system ? summarizeTelemetryText(acceptedRequest.system) : null,
        messages: summarizeTelemetryMessages(acceptedRequest.messages),
        metadata: {
          target_level: targetLevel,
          source_ids: sourceIds,
          source_level: sources[0]?.level ?? null,
          source_level_shown: sourceLevelShown,
          target_tokens: targetTokens,
          model: this.requireCompressionModel(),
          latency_ms: Date.now() - callStart,
          summary_id: logNewSummaryId,
          ...(logWithdrawn ? { withdrawn: true } : {}),
        },
        response: summarizeTelemetryText(logResponse),
        error: logError,
      }, this.ns);
    }
  }

  /** Inventory, not solver eligibility: pins, locks, and geometry can prevent using these summaries. */
  protected summaryInventoryDiagnostics(): {
    deepestAvailableLevel: number;
    summaryCountsByLevel: Record<number, number>;
  } {
    const summaries = new Map(this.summaries.map(summary => [summary.id, summary]));
    const summaryCountsByLevel: Record<number, number> = {};
    let deepestAvailableLevel = 0;
    for (const summary of summaries.values()) {
      summaryCountsByLevel[summary.level] = (summaryCountsByLevel[summary.level] ?? 0) + 1;
      deepestAvailableLevel = Math.max(deepestAvailableLevel, summary.level);
    }
    return { deepestAvailableLevel, summaryCountsByLevel };
  }

  /**
   * The substantive text length of a chunk the thin-chunk guard stubs (an L1
   * written without a model call: no non-text block, and less trimmed text
   * than minChunkCharsForLLM), or undefined for a chunk it doesn't.
   */
  protected thinChunkChars(chunk: Chunk): number | undefined {
    const minChunkChars = this.config.minChunkCharsForLLM ?? 200;
    if (minChunkChars <= 0) return undefined;
    let substantiveChars = 0;
    for (const m of chunk.messages) {
      for (const b of m.content) {
        if (b.type !== 'text') return undefined;
        substantiveChars += b.text.trim().length;
      }
    }
    return substantiveChars < minChunkChars ? substantiveChars : undefined;
  }

  /**
   * Whether the drain has compression work it will take that would shrink the
   * context, as tick takes it: compression in flight; the queued merges, with
   * `hierarchical` on and a compression model, in tick's order up to one a
   * compression hold blocks (tick runs no merge from there until the
   * release, though it takes queued chunks first; merges can queue with
   * `hierarchical` off, but tick runs none then); or a queued chunk tick
   * would compress while it runs chunks at all (while the speculative cap
   * holds nothing). Each counts only when its summary would fold a
   * message the selection can fold now (below). Tick takes the merges in
   * order, the head each call: it runs a head that folds nothing (a model
   * call, or a drop with none when it's stale) and takes the next once that
   * call lands or drops it, and returns at a head a hold blocks. So the walk
   * goes past a merge that folds nothing and ends at one a hold blocks. A
   * call that fails or that the host withdraws leaves the merge at the head
   * for tick's next call, and a refused or non-retryable one leaves it there
   * until mergeAttemptLimit's attempts quarantine it, so the count, which
   * can't know how a call will end, can name work behind a merge that tick
   * reaches only after that. The merge in flight stays at
   * the head until it lands, and the walk reads it there: a hold placed since
   * ends the walk at it, since tick discards what its call returns and stops
   * at that head. A queued merge counts even when executeMerge will
   * drop it as stale without a model call (a source not loaded, already
   * parented or held out of merges, or a group its topology check refuses,
   * which it quarantines),
   * when a source in memory covers such a message: tick drops one such entry
   * a call, so the count can name compression for it until tick reaches it.
   * A merge none of whose sources is in memory covers no message, and names
   * nothing. A chunk counts when
   * it's still uncompressed, holds no held message, has a message the
   * selection can fold now, and has no message an L1 in memory already
   * covers: its L1 shrinks the context on either path. An L1 only the store
   * holds isn't in memory, so its chunk counts too: when tick starts on the
   * chunk it adopts such an L1 that matches the chunk exactly (findExactL1
   * reads the store), and compresses the chunk otherwise, and either way the
   * selector gets an L1 to fold through. A chunk with a covered message counts only on the
   * hierarchical path, when an L1 matches it exactly (in memory, or only in
   * the store, which tick's adoption reads too) and chunk persistence is
   * on: selectHierarchical renders an uncompressed chunk's messages raw beside
   * the L1s, and tick's adoption marks the chunk's record compressed, so the
   * next rebuild drops that fallback. The adaptive picker already folds a
   * covered message through its L1, so adoption changes nothing there. Tick
   * drops a chunk covered under other boundaries without marking its record,
   * so the next rebuild brings it back, and it refuses one partly covered, so
   * neither counts on either path. shouldCompressPreflight isn't consulted:
   * it gates only the speculative drain, and a host's tick (as a refusal's
   * recovery runs it) takes a queued chunk whatever it says. While the cap
   * holds production (past it, with an L1 merge queued), tick runs only
   * merges, and the L1 merge is what relieves it. The count reads the cap
   * once, as it stands when it's asked: an L1 tick makes for a chunk the walk
   * goes past can take the drain past the cap and queue a merge first, and
   * tick then merges before it takes the chunk that counts, reaching it once
   * that merge has run. Following the cap through the walk would take the
   * merges tick queues on the way, which the count can't know. So while the
   * cap holds, no queued chunk counts, though the merge that holds it may
   * fold nothing and release the cap when it lands. A held
   * chunk
   * can be queued: select's rebuild leaves one out, but a produce op queues
   * the chunks it demands, held or not. Tick drops a held one from the queue
   * without compressing it, and its next call takes the next chunk, so a
   * chunk queued behind a held one still counts.
   * Tick takes the queued chunks in order, one a call, and reaches a merge
   * only once it has taken them all. It takes a chunk's steps in this order:
   * it adopts an exact L1, drops or refuses a chunk with a covered message,
   * and stubs a thin one, all without a model call; then it defers for the
   * host's tools, needs a compression model, and skips a chunk the
   * compression quarantine holds. The count walks the queue the same way and
   * stops at the first chunk that needs a model call without a compression
   * model, or while the quarantine can't be read (where tick's own read
   * throws, quarantinedChunkSources): tick throws at such a chunk unless it
   * defers it for the host's tools first, and a host's tick loop ends at a
   * throw. So a chunk tick adopts an L1 for or stubs counts, if the selection
   * can fold one of its messages, whatever the tools or the quarantine say,
   * unless such a chunk is ahead of it, and so does a merge behind chunks
   * tick only skips or takes without making room. Without a compression model
   * no merge counts: tick drops a stale head merge without a model call, and
   * throws at the first merge it would make (executeMerge needs the model).
   * The chunks it settles for good then are those it adopts an L1 for or
   * stubs (its drop of a covered chunk doesn't last, as above). Until the
   * host declares its tools, tick defers
   * any other chunk whose request carries a tool block, and every other
   * chunk when the summarizer refuses requests without them (Fable and
   * Mythos), so those don't count; the tools are read from the context
   * initialize was given, whose getter follows the host. The request is read
   * as stored (requestCarriesToolBlocks), where tick strips unpaired tool
   * blocks first, so one whose only tool blocks are unpaired is left out
   * too: the count can under-name here, but never names a chunk tick defers.
   * The walk stops at a chunk that needs a model call, without a model or a
   * readable quarantine, before it asks about tools, since that stored read
   * can't always tell whether tick would defer the chunk: where tick would
   * defer such a chunk and go on, the count leaves out the work behind it.
   * A chunk that needs a model call while the quarantine holds it doesn't
   * count, and the walk goes past it, as tick does; one tick adopts an L1 for
   * or stubs counts though the quarantine holds it, since tick does both
   * before it reads the quarantine. Nor does a chunk with no message the
   * selection can fold now, one outside the head and recent windows that no
   * pin keeps raw (getCompressibleMessages, the chunker's own reading): both
   * selectors render the head, the recent window and a message such a pin
   * keeps as raw, so its L1 frees no room. Tick still takes it in turn, so
   * the walk goes past it where tick moves on (after adopting an L1 for it,
   * stubbing it, or compressing it with a model), and stops at it where tick
   * throws, as at any chunk that needs a model call without a model or a
   * readable quarantine. The same holds for a merge, whose messages are the
   * leaves of its sources, expanded through the summaries in memory as
   * selectHierarchical expands them, and for the work in flight: the
   * messages of the chunk tick took, or the leaves of the merge it runs
   * (pendingCompressionWork). Work in flight that folds nothing doesn't
   * count, nor does a chunk its call skipped for the quarantine, which makes
   * no model call, nor work a compression hold placed since reaches (for a
   * chunk, one of its messages held, chunkHasHeldMessage's rule; for a merge,
   * mergeBlockedByHold), since its landing checks the hold and discards what
   * the call returns. Nor does a chunk whose result has landed before the
   * call ends, its compressed flag set, since the compile folds through its
   * summary from then: its success and adoption paths set the flag and then
   * await a quarantine clean-up (clearQuarantineForCompressedChunk), a store
   * write when a record matches the chunk. A merge's L2 lands with no await
   * left before its call ends, so the moment between its landing and tick's
   * finally is a microtask, and the count can name compression for a merge
   * then, as the walk reads it at the head until tick dequeues it. Either
   * way the count goes on to the queue: tick takes the next chunk once the
   * call ends, and a merge in flight is still the head, where the walk reads
   * it. A pendingCompression with nothing
   * recorded beside it counts as it did: tick can leave one for a moment
   * when a call's synchronous start finds the branch gone
   * (requireLoadedBranch can clear the record with the mirrors before it
   * throws), until tick's finally, and a subclass that sets the field itself
   * can leave one. The count assumes
   * the host keeps ticking: one that ticks a
   * fixed number of times between compiles reaches work only within that
   * many queued chunks, since each compile queues the skipped ones again.
   * Like tick, this assumes the manager has a membrane to run it.
   * checkReadiness waits on more: chunks the cap or a hold keeps, and a merge
   * a hold blocks. Compressing a chunk replaces its raw messages with a
   * summary, and a merge folds summaries into one.
   *
   * `within`, when given, narrows what counts to work that folds one of those
   * messages: a hierarchical refusal in the middle passes the messages its
   * refused prefix holds, raw or under a summary it sends, since work that
   * folds none of them can't shrink it. Every rule above reads the narrowed
   * set as it reads the whole, except a compression in flight with nothing
   * recorded beside it, which counts whatever the prefix holds, since nothing
   * says what it folds.
   */
  protected compressionWorkQueued(
    store: MessageStoreView,
    path: 'adaptive' | 'hierarchical',
    within?: ReadonlySet<MessageId>,
  ): boolean {
    // Work frees room only where its summary folds a message the selection
    // can fold now: both selectors keep the head and recent windows raw, and
    // a message a pin keeps raw. That's the chunker's own reading of what's
    // compressible (getCompressibleMessages).
    const foldable = new Set(
      this.getCompressibleMessages(store).map((m) => m.id).filter((id) => within === undefined || within.has(id)),
    );
    const foldsNothing = (chunk: Chunk): boolean => !chunk.messages.some((m) => foldable.has(m.id));
    // A merge's messages are the leaves of its sources, expanded through the
    // summaries in memory as the selectors expand them; a source not loaded
    // gives none.
    let summariesById: Map<string, SummaryEntry> | undefined;
    const mergeFolds = (sourceIds: readonly string[]): boolean => {
      summariesById ??= new Map(this.summaries.map((s) => [s.id, s]));
      const leaves = new Set<MessageId>();
      for (const id of sourceIds) {
        const source = summariesById.get(id);
        if (source) this.expandSummaryToLeafMessageIds(source, summariesById, leaves);
      }
      for (const leaf of leaves) if (foldable.has(leaf)) return true;
      return false;
    };
    // Work in flight counts when it folds something now, its call hasn't
    // skipped it for the quarantine, and no compression hold placed since
    // reaches it, since its landing checks the hold and discards what the
    // call returns: a chunk's L1, tick then taking the next
    // chunk, or a merge's L2, the merge staying at the head, where tick then
    // stops. Otherwise the count goes on to the queue, where a merge in
    // flight is still the head. A pendingCompression with nothing recorded
    // beside it counts as it did: tick can leave one for a moment when a
    // call's synchronous start finds the branch gone, and a subclass that
    // sets the field itself can leave one.
    const held = this.holdBlockedIds(store);
    if (this.pendingCompression) {
      const work = this.pendingCompressionWork;
      if (work === null) return true;
      if ('chunk' in work) {
        // Its result has landed once the chunk is compressed; until then,
        // chunkHasHeldMessage's rule over its messages. A chunk its call
        // skipped for the quarantine makes no model call, so it doesn't count,
        // though tick's hop after the call keeps it in flight.
        const ids = work.chunk.messages.map((m) => m.id);
        const reached = held !== null && ids.some((id) => held.has(id));
        if (!work.skipped && !work.chunk.compressed && !reached && ids.some((id) => foldable.has(id))) return true;
      } else if (!this.mergeBlockedByHold([...work.sourceIds], store, held) && mergeFolds(work.sourceIds)) {
        return true;
      }
    }
    // Without a compression model no merge counts: tick drops a stale head
    // merge without a model call, and throws at the first merge it would make
    // (executeMerge needs the model). It reaches a merge only once it has
    // taken every queued chunk, or while the cap holds production. With a
    // model, tick takes the merges in order, the head each call: it runs a
    // head that folds nothing (a model call, or a drop with none when it's
    // stale) and takes the next once that call lands or drops it, and
    // returns at a head a hold blocks.
    // A call that fails, is refused or is withdrawn leaves the merge at the
    // head, so work behind it waits for a later call, which the count can't
    // foresee. So the walk goes past a merge that folds nothing and ends at
    // one a hold blocks, reading the hold set the count read above; a stale
    // merge counts until tick has dropped it, if it folds something now. A
    // merge in flight is still the head: a hold placed since ends the walk
    // there, since tick discards what its call returns and stops at it.
    const modelled = Boolean(this.config.compressionModel);
    let mergeCounts = false;
    if (this.config.hierarchical && modelled) {
      for (const merge of this.mergeQueue) {
        if (this.mergeBlockedByHold(merge.sourceIds, store, held)) break;
        if (mergeFolds(merge.sourceIds)) {
          mergeCounts = true;
          break;
        }
      }
    }
    if (this.compressionQueue.length === 0 || this.speculativeCapHolds()) return mergeCounts;
    const adoptionShrinks = path === 'hierarchical' && this.chunkPersistenceEnabled;
    const coveredByL1 = new Set<string>();
    const exactL1 = new Set<string>();
    for (const summary of this.summaries) {
      if (summary.level !== 1 || !Array.isArray(summary.sourceIds)) continue;
      for (const id of summary.sourceIds) coveredByL1.add(id);
      exactL1.add(summary.sourceIds.join(':'));
    }
    // tick adopts an exact L1 the store holds too (findExactL1).
    const persisted = this.store?.getStateJson(this.summariesStateId);
    for (const summary of Array.isArray(persisted) ? (persisted as SummaryEntry[]) : []) {
      if (summary?.level === 1 && isIdList(summary.sourceIds)) exactL1.add(summary.sourceIds.join(':'));
    }
    // Until the host has declared its tools, tick defers a chunk it would
    // call the model for when its request carries tool blocks, or every such
    // chunk when the summarizer refuses requests without them.
    const deferredForTools: (chunk: Chunk) => boolean =
      (this.hostContext?.tools?.length ?? 0) > 0 ? () => false
        : isToolsLessRefusingSummarizer(this.config.compressionModel ?? '') ? () => true
          : this.requestCarriesToolBlocks(store);
    const quarantined = this.quarantinedChunkSources();
    // A chunk that folds nothing frees no room once it has an L1. Tick still
    // takes such a chunk in turn, so the walk goes past it where tick does.
    // Tick takes the queued chunks in order, one a call, and a host's tick
    // loop ends at the first call that throws.
    for (const index of this.compressionQueue) {
      const chunk = this.chunks[index];
      if (chunk === undefined || chunk.compressed || this.chunkHasHeldMessage(chunk, held)) continue;
      const adoptable = exactL1.has(this.chunkKey(chunk));
      if (chunk.messages.some((m) => coveredByL1.has(m.id))) {
        if (adoptionShrinks && adoptable && !foldsNothing(chunk)) return true;
        continue;
      }
      if (adoptable || this.thinChunkChars(chunk) !== undefined) {
        if (!foldsNothing(chunk)) return true;
        continue;
      }
      // Any other chunk needs a model call. Tick throws at it without a
      // model, or when the quarantine can't be read, unless it defers it for
      // the host's tools first. deferredForTools can't always tell: unless
      // the summarizer refuses requests without tools, it reads the request
      // as stored, which can hold a tool block tick strips. So without a
      // model or a readable quarantine the walk stops here whatever it says:
      // going on could count work behind a chunk tick throws at.
      if (!modelled || quarantined === undefined) return false;
      if (deferredForTools(chunk) || quarantined.has(sha256Json(chunk.messages.map((m) => m.id))) || foldsNothing(chunk)) continue;
      return true;
    }
    return mergeCounts;
  }

  /**
   * Whether tick's request for a chunk carries a tool block, read as stored:
   * the chunk's own messages, and, unless compressionSourceOnly, each message
   * the request carries raw ahead of the chunk, by the coverage tick's request
   * reads with the pins before the chunk (recallCoverage). From the lower of
   * the start and end of the head that request gives (headAsOf, the head as
   * of the chunk, its end clipped at a hold as tick clips it, and 0 with the
   * head window off, headWindowTokens <= 0), that's every message the coverage
   * leaves uncovered, up to the chunk or to that head's end, whichever is
   * later. Before it, only what pins keep raw: the
   * messages of an L1 a pin opens, and a pinned message. Tick lays its
   * history out without the pins when the raw they add doesn't fit, so the
   * pins can only add raw here that tick leaves out; and tick strips unpaired
   * tool blocks first. So this can say yes where tick's request has none,
   * never the reverse. The test it returns takes one chunk. Chunks with the
   * same pins before them, and the same head start, read the same coverage
   * from the same place, so each is read once, for the first message its
   * request carries raw with a tool block, and a chunk's answer is whether
   * that message comes before the later of the chunk's start and its head's
   * end.
   */
  private requestCarriesToolBlocks(store: MessageStoreView): (chunk: Chunk) => boolean {
    const all = store.getAll();
    const sourceOnly = this.config.compressionSourceOnly === true;
    const position = new Map(all.map((message, i) => [message.id, i]));
    const pins = sourceOnly ? [] : [...this.forceRawPinPositions(all)].sort((a, b) => a - b);
    // Built at the first head read, so a count that reads none (source-only,
    // or each chunk holding a tool block itself) scans no holds.
    let heads: ((pos: number) => { start: number; end: number }) | undefined;
    // For each count of pins before a chunk and the start its head's raw
    // reading takes, the index of the first message that request carries raw
    // with a tool block, or all.length for none.
    const firstToolBlock = new Map<string, number>();
    return (chunk) => {
      if (chunk.messages.some((m) => hasToolBlocks(m.content))) return true;
      if (sourceOnly) return false;
      // The chunk's start as tick's request takes it (startInStore).
      const start = this.startInStore(chunk.messages.map((m) => m.id), position);
      heads ??= this.headsAsOf(store);
      const head = heads(start);
      const headEnd = head.end;
      const from = Math.min(head.start, headEnd);
      const pinned = pins.filter((i) => i < start);
      const key = `${pinned.length}:${from}`;
      let first = firstToolBlock.get(key);
      if (first === undefined) {
        const pinnedIds = new Set(pinned.map((i) => all[i].id));
        const seen = this.recallCoverage(pinnedIds);
        // Before `from`, the request carries only what pins keep raw: an L1 a
        // pin opens, and a pinned message. (Either lies before headEnd there,
        // since from is at most headEnd.)
        const carried = (message: StoredMessage, i: number): boolean =>
          !seen.coveredMessageIds.has(message.id)
          && (i >= from || seen.openedMessageIds.has(message.id) || pinnedIds.has(message.id));
        const found = all.findIndex((message, i) => carried(message, i) && hasToolBlocks(message.content));
        first = found === -1 ? all.length : found;
        firstToolBlock.set(key, first);
      }
      return first < Math.max(headEnd, start);
    };
  }

  /**
   * The source hashes (chunkSourceHash) of the chunks the compression
   * quarantine holds under the current budget accounting, from the durable
   * projection tick reads (empty without a store), or undefined when that
   * projection can't be read: tick's own read throws there, so it takes no
   * chunk past it to a model call. Tick skips a chunk the quarantine holds
   * without a model call when the quarantine holds its request family, or the
   * chunk has reached its cap of quarantined shapes under the same request
   * regime; a request of a new shape, or a regime the configuration changed,
   * gets a fresh attempt. Counting none of them under-names that, the safe
   * side: naming work tick won't do tells a host to wait for nothing.
   */
  private quarantinedChunkSources(): Set<string> | undefined {
    let projection: Map<string, ActiveCompressionQuarantine>;
    try {
      projection = this.readCompressionQuarantineProjection();
    } catch {
      return undefined;
    }
    const sources = new Set<string>();
    for (const active of projection.values()) {
      if (active.record.normalizedConfig?.accountingVersion === COMPRESSION_BUDGET_ACCOUNTING_VERSION) {
        sources.add(active.record.chunkSourceHash);
      }
    }
    return sources;
  }

  /** Attach common metadata; each internal refusal must also declare its count/depth meanings. */
  protected overBudgetError(
    budget: TokenBudget,
    opts: ConstructorParameters<typeof OverBudgetError>[0] & {
      diagnostics: Required<Pick<OverBudgetError['diagnostics'], 'middleCountUnit' | 'deepestLevelKind'>>;
    },
  ): OverBudgetError {
    return new OverBudgetError({
      ...opts,
      diagnostics: {
        ...opts.diagnostics,
        ...this.summaryInventoryDiagnostics(),
        configuredBudget: budget.maxTokens,
        reserveForResponse: budget.reserveForResponse,
        inputBudget: budget.maxTokens - budget.reserveForResponse,
      },
    });
  }

  /**
   * The pins that keep messages raw in the adaptive plan's middle, for its
   * refusal to name (`OverBudgetDiagnostics.rawPins`): the positions the plan
   * folds history in (before the tail's start, which is the recent window's
   * start or the head's end where the recent window reaches back into the
   * head, and outside the head window; with the head window disabled after a
   * reset, the plan's tail holds the recent messages before the head) that
   * pins keep raw
   * (`forceRawPinPositions`), each priced by `price`, the plan's own raw
   * price. Every such position counts, a part locked with `lockChunk` among
   * them, so the tokens are what unpinning frees at most: a pin that keeps no
   * part raw alone is still named. Where bounds are read, a pin whose own
   * bound isn't raw keeps nothing raw, so it isn't named even where it
   * overlaps a raw pin; where they aren't, every pin renders raw. Undefined
   * when no pin keeps any.
   */
  private rawPinsDiagnostics(store: MessageStoreView, price: (position: number) => number): OverBudgetDiagnostics['rawPins'] {
    if (this.pins.length === 0) return undefined;
    const messages = store.getAll();
    const raw = this.forceRawPinPositions(messages);
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const tailStart = Math.max(this.getRecentWindowStart(store), headEnd);
    const kept = (i: number): boolean => raw.has(i) && i < tailStart && !(i >= headStart && i < headEnd);

    let tokens = 0;
    for (const i of raw) if (kept(i)) tokens += price(i);
    if (tokens === 0) return undefined;
    const positionOf = this.positionIndex(messages);
    const readsBounds = this.readsPinBounds();
    const pins: OverBudgetRawPin[] = [];
    for (const pin of this.pins) {
      const bound: ResolvedPinBound = pin.level !== undefined ? { level: pin.level }
        : pin.maxLevel !== undefined ? { maxLevel: pin.maxLevel } : 'raw';
      if (readsBounds && !AutobiographicalStrategy.isRawPinBound(bound)) continue;
      const at = this.pinPositions(pin, positionOf, messages);
      if (!at) continue;
      let own = 0;
      for (const i of at) if (kept(i)) own += price(i);
      if (own === 0) continue;
      const named = Math.abs(positionOf.get(pin.lastMessageId)! - positionOf.get(pin.firstMessageId)!) + 1;
      pins.push({
        pinId: pin.id, kind: pin.kind, ...(pin.name === undefined ? {} : { name: pin.name }),
        firstMessageId: pin.firstMessageId, lastMessageId: pin.lastMessageId,
        ...(at.length > named ? { parts: at.length } : {}), tokens: own,
      });
    }
    return { tokens, pins };
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
    this.loadCalibration(store, { dryRun });
    const messages = store.getAll();
    this.refreshStoreOrder(messages);
    if (_diag) { this.diag.error(`[cm-cache] selectAdaptive: calibration+getAll ${Date.now() - _t}ms`); _t = Date.now(); }
    const msgCap = this.config.maxMessageTokens;
    // Post-strip estimates (see postStripEstimates): the budgeting sites in
    // this method price a message the way the stripped render will cost it,
    // apart from the exceptions applyImageStripping's asEstimated names.
    const pse = this.postStripEstimates(store);
    if (_diag) { this.diag.error(`[cm-cache] selectAdaptive: pse ${Date.now() - _t}ms`); _t = Date.now(); }
    // A middle message's raw price, as the plan prices it and its refusal
    // prices the pins that keep it raw (rawPinsDiagnostics). The shard path
    // in step 5 sends a run of a body's raw shards as one entry, their text
    // joined and uncut, so a shard takes no extra.
    const middlePrice = (i: number): number => {
      const msg = messages[i]!;
      return msg.bodyGroupId ? pse[i]! : pse[i]! + this.cappedForSend(store, msg, msgCap).extra;
    };

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
      const tokens = pse[i] + this.cappedForSend(store, msg, msgCap).extra;
      headMessageIds.add(msg.id);
      headTokens += tokens;
    }
    const effectiveRecentStart = Math.max(recentStart, headEnd);
    for (let i = effectiveRecentStart; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = pse[i] + this.cappedForSend(store, msg, msgCap).extra;
      tailMessageIds.add(msg.id);
      tailTokens += tokens;
    }

    if (headTokens + tailTokens > rejectionBudget) {
      // Compression never touches the raw windows. A smaller recent window
      // moves history out of the tail into the middle, which clears this
      // refusal when the head fits beside the newest turn as the compile must
      // keep it raw. The middle then folds only once its chunks have closed
      // and compression has summarized them, so the next refusal can be the
      // picker's. No window starts after a compression hold
      // (getRecentWindowStart). The newest turn is the newest body, which the
      // structural repair refuses a compile to leave out. For a body split
      // into shards at ingress, its newest shard is all that must stay raw,
      // since the earlier shards can close into chunks and fold, unless the
      // body holds a tool_result: ingress puts a
      // split message's non-text blocks on its first shard
      // (chunkIngressMessage), and a result whose call isn't raw just before
      // it is blanked as an orphan (enforceToolPairing), without a refusal.
      // So when the newest body holds a tool_result, the turn is the whole
      // body and the whole call before it, from the call's first shard, as
      // holdBoundary counts it. A hold inside the head leaves every window's
      // tail starting at the head's end, so a floor counted from the hold
      // covers at least the tail, and nothing is named, as it should be. So
      // does a newest turn that starts inside the head.
      let floorTokens = 0;
      if (messages.length > 0) {
        const newestBody = bodyStart((k) => messages[k], messages.length - 1);
        const newestTurn = newestBody > 0 && this.hasToolResult(messages[newestBody])
          ? bodyStart((k) => messages[k], newestBody - 1)
          : messages.length - 1;
        const floorStart = Math.min(newestTurn, this.holdBoundary(store));
        for (let i = floorStart; i < messages.length; i++) {
          floorTokens += pse[i] + this.cappedForSend(store, messages[i], msgCap).extra;
        }
      }
      throw this.overBudgetError(budget, {
        stage: 'Head/tail reservation exceeded budget',
        budget: rejectionBudget,
        actual: headTokens + tailTokens,
        clearedBy: headTokens + floorTokens <= rejectionBudget ? ['smaller-recent-window'] : [],
        diagnostics: {
          middleCountUnit: 'picker-chunks',
          deepestLevelKind: 'unplanned',
          headTokens,
          tailTokens,
          middleTokens: 0,
          // Include pre-head history after a reset, as middleSegments does below.
          middleChunkCount: messages.length - headMessageIds.size - tailMessageIds.size,
          deepestLevel: 0,
        },
      });
    }

    const prefixBudget = rejectionBudget - tailTokens;
    let totalTokens = 0;

    // Emit the already-reserved head entries raw, each cut at the cap as any
    // raw message is.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const { content, extra } = this.cappedForSend(store, msg, msgCap);
      const tokens = pse[i] + extra;
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
    // rebuildChunks ran on this same listing just before (select), so its
    // per-position owner table answers directly; any other listing gets a map.
    const chunkAtPosition = this._chunkByPosition?.listing === messages ? this._chunkByPosition.chunks : null;
    let chunksByMessageId: Pick<ReadonlyMap<MessageId, Chunk>, 'get'>;
    if (chunkAtPosition) {
      const order = this._storeOrder;
      chunksByMessageId = { get: (id) => { const at = order.get(id); return at === undefined ? undefined : chunkAtPosition[at]; } };
    } else {
      const byId = new Map<MessageId, Chunk>();
      for (const ch of this.chunks) for (const m of ch.messages) byId.set(m.id, ch);
      chunksByMessageId = byId;
    }

    // Each pinned position's fold bound, resolved once (resolvedPinBounds),
    // so the picker doesn't fold what the user marked keep-raw and every
    // selector reads a pin as compression does. A chunk carries at most one
    // of `pinned` (raw: a classic pin, or a level or cap of 0), `pinLevel` or
    // `pinMaxLevel`, so every reader of `pinned` agrees on what stays raw.
    // The last two appear only under the strategies that honor them
    // (kv-stable, kv-unified), which must be able to move the chunk to or
    // within its bound; elsewhere a bounded pin resolves to `pinned`. Built
    // once and reused.
    const pinBounds = this.resolvedPinBounds(messages);

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
    const l1ByMessage = this.l1ByMessageIndex();
    const ancestorMemo = new Map<SummaryId, (SummaryEntry | null | undefined)[]>();

    // The foldable middle is everything outside the LIVE head window and the
    // reserved tail — INCLUDING [0, headStart) after a head-window reset.
    // Excluding that zone made pre-transition history invisible to the picker
    // (never planned, never rendered): the adaptive variant of the frontier
    // gap the coverage invariant exists to refuse.
    const middleSegments: ReadonlyArray<readonly [number, number]> = headStart > 0
      ? [[0, headStart], [headEnd, effectiveRecentStart]]
      : [[headEnd, effectiveRecentStart]];

    const pickerChunks: PickerChunk[] = [];
    const salience = this.salienceByPosition(messages);
    for (const [segStart, segEnd] of middleSegments)
    for (let i = segStart; i < segEnd && i < messages.length; i++) {
      const msg = messages[i];
      const ch = chunkAtPosition ? chunkAtPosition[i] : chunksByMessageId.get(msg.id);
      // This is the chunk's raw price (middlePrice). The shard path in step 5
      // prices its joined entry as the shards' text it joins, each by
      // estimateTokens, the store's price, so a shard of text alone is
      // counted there as here; a shard's other blocks are priced here, and
      // the shard path leaves them out. A shard the plan folds is priced as
      // its summary. The head and recent windows cut a shard as they emit it.
      const tokens = middlePrice(i);
      const bound = pinBounds.size > 0 ? pinBounds.get(i) : undefined;
      const l1Id = ch?.summaryId ?? l1ByMessage.get(msg.id);
      pickerChunks.push({
        id: msg.id,
        sequence: i,
        rawTokens: tokens,
        currentResolution: reachableLevel(this.resolutions.get(msg.id) ?? 0, l1Id, summariesById),
        lockedByAgent: this.locked.has(msg.id),
        pinned: bound !== undefined && AutobiographicalStrategy.isRawPinBound(bound),
        pinLevel: bound !== undefined && bound !== 'raw' && 'level' in bound && bound.level > 0 ? bound.level : undefined,
        pinMaxLevel: bound !== undefined && bound !== 'raw' && 'maxLevel' in bound && bound.maxLevel > 0 ? bound.maxLevel : undefined,
        l1Id,
        salience: salience[i],
      });
    }

    // Also include head and tail in PickerChunks (so token accounting matches)
    // — but mark them as in-head/in-tail so the picker won't fold them.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const tokens = pse[i] + this.cappedForSend(store, msg, msgCap).extra;
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
      const tokens = pse[i] + this.cappedForSend(store, msg, msgCap).extra;
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
    // Head and tail chunks were appended after the middle ones, so the
    // middle chunks are the prefix of pickerChunks and this is their count.
    const middleChunkCount = pickerChunks.length - headMessageIds.size - tailMessageIds.size;
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
    if (this.config.foldingStrategy === 'kv-unified') {
      this.kvUnifiedHashes = { current: new Map(), previous: this.kvUnifiedHashes.current };
    }
    const kvUnifiedCheck = this.config.foldingStrategy === 'kv-unified'
      ? this.kvUnifiedCacheForSolve(store, messages, { headStart, headEnd, recentStart: effectiveRecentStart, msgCap })
      : null;
    this.kvUnifiedSolveCache = kvUnifiedCheck?.cache ?? null;
    const picker = this.buildPicker(
      pickerInputs,
      preparedTotal === undefined
        ? undefined
        : {
            totalBudget: preparedTotal,
            targetBudget: preparedTotal * (1 - slack),
          },
      opts?.kvUnifiedImmutablePrefixHash,
      opts?.kvUnifiedContinuityRelaxation,
    );
    // NOTE: a dry run also writes transition bookkeeping below
    // (`lastFrontierTokens` feeds `prepared` in getHotContextSettings(), so a
    // low-budget dry run could make a converging transition look prepared).
    // select() puts it back for every dry run, on ALL throw paths — do not
    // also restore it here, or the two owners will disagree.
    if (_diag) { this.diag.error(`[cm-cache] selectAdaptive: inputs-built ${Date.now() - _t}ms`); _t = Date.now(); }
    const result = picker.run(pickerInputs, foldingBudget);
    // A picker result answers by position; a stubbed result (tests, hosts
    // that wrap the picker) may only carry the map.
    const levelAt: PickerResult['levelAt'] = typeof result.levelAt === 'function'
      ? result.levelAt
      : (_sequence, id) => result.finalResolutions.get(id) ?? 0;
    if (this.config.foldingStrategy === 'kv-unified') {
      // The plan's check runs dry or not, so a dry select refuses what a real
      // compile would; only the draft it builds is a real compile's alone.
      const reuse = this.kvUnifiedReuse;
      // The tree is only needed for a leaf the forest cannot hash at its
      // level and for rendering the layout when the solver did not; build
      // it on first use. Deriving from an older tree still works: derive
      // only needs the previous leaves intact and new leaves ownerless.
      let tree: SummaryTree | null = null;
      const summaryTree = (): SummaryTree => tree ??=
        (reuse.tree ? SummaryTree.derive(reuse.tree, pickerInputs) : null) ?? new SummaryTree(pickerInputs);
      const nextSequence = (this.kvUnifiedReceipts.head?.sequence ?? 0) + 1;
      const leaves = new Map<ChunkId, PresentedLeaf>();
      // The forest the picker just solved on carries each leaf's hash per
      // level; the tree is the fallback for leaves it does not know.
      const forest = reuse.forest;
      // A forest built from these inputs lists its leaves in the inputs'
      // order when the chunks were already sorted, which the strategy's
      // position-sequenced chunks are; then the leaf is a positional read.
      const forestCurrent = forest?.builtFrom(pickerInputs) === true;
      if (forestCurrent && !dryRun) this.reportHeldLevelPins(forest!, messages);
      const forestChunks = forestCurrent ? forest!.orderedChunks() : null;
      let dense = forestChunks !== null && forestChunks.length === pickerInputs.chunks.length;
      for (let k = 0; dense && k < forestChunks!.length; k++) dense = forestChunks![k].sequence === k;
      const forestLeaves = dense ? forest!.orderedLeaves() : null;
      for (let k = 0; k < pickerInputs.chunks.length; k++) {
        const chunk = pickerInputs.chunks[k];
        const level = levelAt(chunk.sequence, chunk.id);
        const leaf = forestLeaves ? forestLeaves[chunk.sequence] : forestCurrent ? forest!.leaf(chunk.id) : undefined;
        const slot = leaf ? leaf.availableLevels.indexOf(level) : -1;
        let repHash: string;
        if (leaf && slot >= 0) {
          repHash = leaf.repHashes[slot];
        } else {
          const summaryId = level > 0 ? summaryTree().ancestorAt(chunk.id, level)?.id : undefined;
          if (level > 0 && !summaryId) {
            throw new Error(`kv-unified selected unavailable L${level} for ${chunk.id}`);
          }
          repHash = level === 0 ? `raw:${chunk.id}` : `summary:${summaryId}`;
        }
        if (dryRun) continue;
        const previous = this.kvUnifiedReceipts.leaves.get(chunk.id);
        // An unchanged leaf keeps its receipt object: no allocation, and the
        // chain's diff sees identity before it compares fields.
        leaves.set(chunk.id, previous && previous.repHash === repHash && previous.level === level
          ? previous
          : { repHash, level, lastChangedSeq: nextSequence });
      }
      if (!dryRun) {
        // With a live cache the solver's terminal evaluator already rendered the
        // selected cut's layout (the same units, tokens and offsets renderLayout
        // produces; asserted equal in the terminal evaluator tests). The size
        // check ties it to this compile's applied frontier.
        const last = this._lastKvUnified?.lastResult;
        const solvedLayout = last?.feasible && last.cacheRelevant && result.levelsBySequence !== undefined &&
          last.selected.levels === result.levelsBySequence ? last.selected.layout : null;
        this.kvUnifiedDraft = {
          leaves,
          layout: solvedLayout ?? renderLayout(pickerInputs, summaryTree(), result.finalResolutions),
          immutablePrefixHash: opts?.kvUnifiedImmutablePrefixHash,
          markerUnitIndices: [],
        };
        if (tree) reuse.tree = tree;
      }
    }
    if (_diag) { this.diag.error(`[cm-cache] selectAdaptive: picker.run ${Date.now() - _t}ms`); _t = Date.now(); }
    this.lastFrontierTokens = result.finalTokens;
    // PLANNER/EMITTER RECONCILIATION (2026-07-26). The picker plans against
    // estimates; the emitter then spends real tokens per entry. When the two
    // disagree the emitter can overrun a plan that "fit", and the overrun is
    // paid by whatever renders last — the recent window — which is how tail
    // eviction becomes reachable at all. Eviction is therefore a symptom of
    // plan drift, not of scarce foldable material: the picker either reaches
    // its target or raises OverBudgetError. Record the plan so rsEnd() can
    // compare it against what was actually committed (its other figures,
    // `_plannedMeta`, once the changes are staged below).
    this._plannedTokens = result.finalTokens;

    // Every trust-region override is loud (design §13.4) — silence was half
    // of the 2026-07-12 incident.
    const plan = this._lastKvStable?.lastPlan();
    this.transitionBlocked = plan?.blocked === 'reach-floor'
      ? 'transition-pace-floor'
      : plan?.blocked === 'target-floor'
        ? 'prepared-window-floor'
        : undefined;

    // Stage resolution changes for the next compile, but do NOT commit them
    // yet. The selected frontier is only authoritative if the whole render
    // succeeds. Persisting here used to let a plan that later threw
    // OverBudgetError (or failed coverage/emission checks) poison the carried
    // frontier for every subsequent compile — exactly the Sill 2026-09-16
    // outage shape. Produce/demand ops below intentionally remain allowed on
    // a failed compile: they are recovery work, not presentation state.
    const pendingResolutionChanges: Array<[string, number]> = [];
    let deepestLevel = 0;
    // Reported with the layout only once the compile commits (below).
    let selectionCause: string | undefined;
    // The middle chunks are the prefix of pickerChunks (head and tail were
    // appended after them). A change is staged against the saved level, not
    // the level the chunk was planned from, which is lower when the saved
    // level's summary is gone (reachableLevel), so the commit saves what this
    // compile presents. A locked chunk keeps its saved level. A dry run stages
    // them too, so that its `moves` counts them, and commits none (below).
    for (let k = 0; k < middleChunkCount; k++) {
      const chunk = pickerChunks[k];
      const id = chunk.id;
      const level = levelAt(chunk.sequence, id);
      if (level > deepestLevel) deepestLevel = level;
      if (this.locked.has(id)) continue;
      const prev = this.resolutions.get(id) ?? 0;
      if (prev !== level) pendingResolutionChanges.push([id, level]);
    }
    // `moves` reports the changes staged here, the saved levels the commit
    // writes. The picker's own count compares each chunk with the level it was
    // planned from, so it counts a locked chunk that a pin renders at another
    // level, though the commit never stores that, and misses a chunk whose
    // saved level's summary is gone, though the commit stores its new level
    // (#195).
    this._plannedMeta = {
      budgetMet: result.budgetMet,
      exhausted: result.exhausted,
      moves: pendingResolutionChanges.length,
      solver: picker.solverName,
    };
    // This compile's own plan reports the leaves its summaries disagree with
    // here, beside [kv-escalation], rather than in the planner: the shadow
    // production pick below plans the same way and renders nothing (design
    // §13.6). A dry run reports the plan it previews, as it reports an
    // override.
    if (plan) reportOverlap(plan.overlap, this.diag);
    if (plan?.override) {
      this.diag.error(
        `[kv-escalation] override=${plan.override} perturbation=${plan.perturbation}` +
          ` tokens=${plan.tokens} budget=${foldingBudget.totalBudget}` +
          ` deepestPlannedLevel=L${deepestLevel}` +
          ` deepestAvailableLevel=L${this.summaryInventoryDiagnostics().deepestAvailableLevel}` +
          ` (see adaptive-resolution-design.md §13.4)`,
      );
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
      const liveKvUnified = this._lastKvUnified;
      try {
        const shadowResult = this.buildPicker(pickerInputs).run(pickerInputs, {
          totalBudget: prodBudget,
          targetBudget: prodBudget * (1 - slack),
          slack,
        });
        if (shadowResult.produced.length > 0) {
          this.handleProducedOps(shadowResult.produced, { speculative: true });
        } else if (shadowResult.exhausted) {
          this.diag.warn(
            `autobio: production target ${prodBudget} unreachable even fully folded ` +
              `(${shadowResult.finalTokens} tokens); lowering the live budget to it ` +
              `would hard-fail with OverBudgetError`,
          );
        }
      } catch (err) {
        // A failing shadow pick must never break the live compile.
        this.diag.warn('autobio: shadow production pick failed:', err);
      } finally {
        // The shadow pick is not a compile. Put back the strategy instances
        // behind the live pick: _lastKvStable for §13.4 observability, and
        // _lastKvUnified for the live solve's timings on [plan-vs-actual].
        this._lastKvStable = liveKvStable;
        this._lastKvUnified = liveKvUnified;
      }
    }

    // The plan's produce ops name summaries it still wants, and producing them
    // is how compression makes room for a deeper fold, but only once there is
    // work to make them: an op over the unclosed trailing span enqueues
    // nothing (enqueueL1ForRange). A dry run doesn't enqueue the ops at all.
    // It still sees what's queued, the chunks its own rebuildChunks closed
    // included, so it names compression as the live compile does, unless the
    // work is only what the ops would add: the newest closed chunks, which the
    // holdback (l1HoldbackChunks) keeps out of the queue until they're
    // demanded, or a merge. There a dry run names nothing.
    // Taken at a refusal of this select (the plan check's, or a later
    // stage's), or for a dry run's preview of a plan over the budget, since a
    // plan that fits and renders needs no list.
    const planClearedBy = (): OverBudgetClearedBy[] =>
      result.produced.length > 0 && this.compressionWorkQueued(store, 'adaptive') ? ['compression'] : [];
    const planFits = result.finalTokens <= rejectionBudget;

    // Record what a dry run needs (select() puts back the transition
    // bookkeeping the pick just wrote). Done before the over-budget check so
    // an infeasible preview still reports, with the plan's list as this dry
    // run sees it: since it doesn't queue the plan's own work, it names
    // compression only for work queued by now, the chunks its rebuild closed
    // included.
    if (dryRun) {
      this._lastPreview = {
        finalTokens: result.finalTokens,
        budgetTokens: rejectionBudget,
        fits: planFits,
        ...(planFits ? {} : { clearedBy: planClearedBy() }),
        exhausted: result.exhausted,
        headTokens,
        tailTokens,
        middleTokens: Math.max(0, result.finalTokens - headTokens - tailTokens),
        middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
        deepestLevel,
        resolutions: Object.fromEntries(result.finalResolutions),
        moves: pendingResolutionChanges.length,
        producedCount: result.produced.length,
      };
    }

    // Hard-fail whenever the picker's current plan exceeds the hard budget.
    // A `produce` op only schedules a missing summary; it does not make the
    // current raw plan feasible and must never authorize an inference.
    // A dry run reports infeasibility via `_lastPreview.fits` instead: the
    // whole point of previewing an aggressive budget is to learn it won't fit
    // without taking the outage that learning it live would cause. Except
    // under a provisional multiplier above 1, which a committing select
    // would drop and retry at (selectPath): the dry run throws the same
    // refusal so it takes the same fallback, and its preview says what the
    // real compile will do. If the retry at 1 is still over, it reports.
    const dryFallback = dryRun && this._calibrationProvisional !== null && this._calibration > 1;
    if (!planFits && (!dryRun || dryFallback)) {
      // The plan's middle is what's over, priced as the plan priced it, so
      // the pins keeping raw tokens there are named. The refusals after the
      // plan count other things (an emitted prefix, a shard's text alone)
      // and don't name pins.
      const rawPins = this.rawPinsDiagnostics(store, middlePrice);
      throw this.overBudgetError(budget, {
        budget: rejectionBudget,
        actual: result.finalTokens,
        clearedBy: planClearedBy(),
        diagnostics: {
          middleCountUnit: 'picker-chunks',
          deepestLevelKind: 'planned',
          headTokens,
          tailTokens,
          middleTokens: Math.max(0, result.finalTokens - headTokens - tailTokens),
          middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
          deepestLevel,
          ...(rawPins === undefined ? {} : { rawPins }),
        },
      });
    }

    // ----- 5. Emit middle entries in source order -----
    const positionOf = this.positionIndex(messages);
    // Walk middle messages. Handle two cases:
    //  - bodyGroupId set: collect the consecutive shards of the same body (one
    //    ingestion; a later ingestion of the same text is another body, see
    //    body-runs.ts), emit ONE combined entry with concatenated content (raw shards + inline
    //    summary text for folded shards). This preserves KV — the model sees
    //    one continuous user message instead of N turns.
    //  - bodyGroupId absent: emit normally (raw L0 message, or Q+A summary pair).
    const emittedAncestors = new Set<SummaryId>();

    // Emission-overflow refusal: the picker planned this layout to fit, so an
    // overrun here is estimator drift. The grace window (prefixBudget derives
    // from rejectionBudget) absorbs it; beyond that the select refuses the
    // turn rather than silently dropping whatever happened to render last.
    const middleChunkCountDiag = middleChunkCount;
    const emissionOverBudget = (attempted: number): OverBudgetError =>
      this.overBudgetError(budget, {
        stage: 'Emission overran the plan (planner/emitter estimator drift)',
        budget: rejectionBudget,
        actual: attempted + tailTokens,
        clearedBy: planClearedBy(),
        diagnostics: {
          middleCountUnit: 'picker-chunks',
          deepestLevelKind: 'planned',
          headTokens,
          tailTokens,
          middleTokens: Math.max(0, attempted - headTokens),
          middleChunkCount: middleChunkCountDiag,
          deepestLevel,
        },
      });

    for (const [segStart, segEnd] of middleSegments) {
    let i = segStart;
    while (i < segEnd && i < messages.length) {
      const msg = messages[i];

      if (msg.bodyGroupId) {
        // Collect this body's consecutive shards. Another ingestion of the
        // same text right after it shares the group id but is its own body.
        const groupStart = i;
        // Read no further than this segment: nothing past it is emitted here.
        i = bodyEnd(Math.min(segEnd, messages.length), (k) => messages[k], groupStart) + 1;
        // Store order: a body's shards are already in rising shard order, and
        // the walk stops where an index doesn't rise, which also keeps a
        // region that starts mid-body apart from the next copy (body-runs.ts).
        const shards = messages.slice(groupStart, i);

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
          | { kind: 'raw'; parts: string[]; ids: string[]; tokens: number }
          | { kind: 'summary'; ancestor: SummaryEntry };
        let currentRun: Run | null = null;
        const participant = shards[0].participant;

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
            const tokens = currentRun.tokens;
            if (totalTokens + tokens > prefixBudget) {
              throw emissionOverBudget(totalTokens + tokens);
            }
            entries.push({
              index: entries.length,
              sourceMessageId: undefined,
              // Composite provenance: every shard whose text was concatenated
              // into this entry. Without this the coverage invariant reads the
              // absorbed shards as missing (the body-group-shard false
              // positive) — same fix as mergeAdjacentBodyGroupRaw.
              sourceMessageIds: [...currentRun.ids],
              cacheLayoutKey: currentRun.ids.at(-1),
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
              const [questionEntry, answerEntry] = this.recallPairEntries(ancestor, msgCap, entries.length);
              // Price the same pair the planner selected. responseContent may
              // carry signed-empty thinking whose exact generation cost is in
              // summary.tokens; re-estimating the rendered blocks here would
              // fall back to 600 tokens and make plan-vs-actual lie low.
              const pairTokens = this.recallPairCost(ancestor);
              if (totalTokens + pairTokens > prefixBudget) {
                throw emissionOverBudget(totalTokens + pairTokens);
              }
              entries.push(questionEntry);
              entries.push(answerEntry);
              totalTokens += pairTokens;
              this.rsSummary(ancestor.level, pairTokens, ancestor.id);
            }
          }
          currentRun = null;
        };
        // A raw run joins its shards' text into one block and is priced as
        // the parts it joins, each shard's text by estimateTokens, which is
        // what the plan counted for a shard of text alone. The store's
        // default estimator prices a text block at the rate its first 2,000
        // characters set, so the joined block's own estimate would put the
        // whole run at that rate, and this entry and the plan would disagree
        // wherever the shards' densities differ.
        const addRaw = (shard: StoredMessage): void => {
          if (currentRun?.kind !== 'raw') {
            flushRun();
            currentRun = { kind: 'raw', parts: [], ids: [], tokens: 0 };
          }
          const rawRun = currentRun as Extract<Run, { kind: 'raw' }>;
          rawRun.ids.push(shard.id);
          const text = this.prunedForSend(store, shard).content
            .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text');
          for (const block of text) rawRun.parts.push(block.text);
          rawRun.tokens += this.estimateTokens(text);
        };

        for (const shard of shards) {
          const resolution = levelAt(positionOf.get(shard.id) ?? -1, shard.id);
          if (resolution === 0) {
            addRaw(shard);
          } else {
            const ancestor = this.findAncestorAt(shard.id, resolution, chunksByMessageId, summariesById, l1ByMessage, ancestorMemo);
            if (!ancestor) {
              // Fall back to raw
              addRaw(shard);
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
      const resolution = levelAt(i, msg.id);
      if (resolution === 0) {
        const { content, extra } = this.cappedForSend(store, msg, msgCap);
        const tokens = pse[i] + extra;
        if (totalTokens + tokens > prefixBudget) {
          throw emissionOverBudget(totalTokens + tokens);
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
        const ancestor = this.findAncestorAt(msg.id, resolution, chunksByMessageId, summariesById, l1ByMessage, ancestorMemo,
          chunkAtPosition ? chunkAtPosition[i] ?? null : undefined);
        if (!ancestor) {
          const { content, extra } = this.cappedForSend(store, msg, msgCap);
          const tokens = pse[i] + extra;
          if (totalTokens + tokens > prefixBudget) {
            throw emissionOverBudget(totalTokens + tokens);
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
        const [questionEntry, answerEntry] = this.recallPairEntries(ancestor, msgCap, entries.length);
        const pairTokens = this.recallPairCost(ancestor);
        if (totalTokens + pairTokens > prefixBudget) {
          throw emissionOverBudget(totalTokens + pairTokens);
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
      throw this.overBudgetError(budget, {
        stage: 'Tail emission dropped reserved recent-window messages',
        budget: rejectionBudget,
        actual: totalTokens + tailTokens,
        clearedBy: planClearedBy(),
        diagnostics: {
          middleCountUnit: 'picker-chunks',
          deepestLevelKind: 'planned',
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
    const merged = this.mergeAdjacentBodyGroupRaw(entries, store, messages);

    this.assertFullCoverage(merged, messages, {
      headStart,
      headEnd,
      recentStart: effectiveRecentStart,
    });
    this.postProcessToolEntries(merged);
    // Strip stale images BEFORE placing markers, so they describe the
    // post-strip context the agent actually receives. This selection budgets
    // by postStripEstimates, so the strip counts as they do (see
    // applyImageStripping's asEstimated, which names where it doesn't).
    this.applyImageStripping(merged, store, { asEstimated: true });

    // The newest stored message is the triggering turn for this compile. A
    // structural repair may rewrite tool blocks, but it must never erase that
    // turn. A body's shards merge into one entry, so any surviving shard of the
    // newest body proves the newest shard is present: a head or recent-window
    // merge keeps its first shard's id as sourceMessageId, and a middle-region
    // composite carries every shard's id in sourceMessageIds (its
    // sourceMessageId is unset), which is where the newest body lands when its
    // newest shard alone outgrows the recent window. Only that body's shards
    // count: an earlier ingestion of the same text shares the group id, and its
    // survival proves nothing about the newest turn.
    const newest = messages[messages.length - 1];
    if (newest) {
      const newestBody = bodyBoundsIn(messages, messages.length - 1);
      const newestBodyIds = new Set(messages.slice(newestBody.from, newestBody.to + 1).map(m => m.id));
      const newestRetained = merged.some(
        entry => (entry.sourceMessageId !== undefined && newestBodyIds.has(entry.sourceMessageId)) ||
          (entry.sourceMessageIds ?? []).some(id => newestBodyIds.has(id)),
      );
      if (!newestRetained) {
        throw this.overBudgetError(budget, {
          stage: 'Structural repair did not retain the newest turn',
          budget: rejectionBudget,
          actual: totalTokens + tailTokens,
          // The newest turn is what's missing, and only room for it brings it
          // back. A newer message makes a different turn the newest, and this
          // one then sits in the middle raw until its chunk closes and
          // compression summarizes it, so the next compile is no smaller.
          clearedBy: [],
          diagnostics: {
            middleCountUnit: 'picker-chunks',
            deepestLevelKind: 'planned',
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
    const firstChanged = this.placeCacheMarkers(merged, headMessageIds, tailMessageIds);
    // A dry run made no draft of its own (see the draft's creation), so the
    // draft here is the last real compile's, which a dry layout must not
    // re-mark.
    if (this.config.foldingStrategy === 'kv-unified' && this.kvUnifiedDraft && !dryRun) {
      this.kvUnifiedDraft.markerUnitIndices = this.reconcileKvUnifiedMarkerIndices(
        merged, this.kvUnifiedDraft.layout, headMessageIds, tailMessageIds,
      );
      // Acceptance keeps no reference without the immutable prefix hash.
      if (this.kvUnifiedDraft.immutablePrefixHash !== undefined) {
        this.kvUnifiedDraft.render = this.kvUnifiedRenderRecord(merged, this.kvUnifiedDraft.layout, kvUnifiedCheck?.rebuilt ?? null);
      }
    }
    this.assertMiddleCoverage();

    // Commit the carried frontier only after EVERY refusal-capable stage has
    // succeeded: plan budget, emission budget, tail reservation, structural
    // repair, full coverage, tool pairing, and marker placement. A rejected
    // compile may still enqueue demanded summaries above, but it cannot become
    // the next compile's presentation state.
    if (pendingResolutionChanges.length > 0 && !dryRun) {
      for (const [id, level] of pendingResolutionChanges) this.resolutions.set(id, level);
      this.persistResolutions();
      selectionCause = 'budget-fit';
      // The fold is now real: say once what it moved and where this request
      // first differs from the last one returned. A plan refused before here
      // logs nothing, so a retry doesn't log the same moves twice, and a
      // compile that changes no saved level logs nothing either, however many
      // locked chunks its solver moved (PR #157 review).
      this._lastFoldDiff = this.logFoldDiff(pickerInputs, middleChunkCount, levelAt, merged, firstChanged);
    }
    if (!dryRun) this.pendingSelectionCause = selectionCause;
    // Same commit point for the receipt left behind by kv-unified: a real
    // presentation by a non-kv-unified strategy has now succeeded, so that
    // receipt no longer describes the previous turn (#97). Independent of
    // whether any resolution changed — a no-op compile is still a
    // presentation. A rejected compile keeps it: nothing replaced it.
    if (!dryRun && this.kvUnifiedReceiptSupersedePending && this.config.foldingStrategy !== 'kv-unified') {
      this.supersedeKvUnifiedReceipt();
    }
    const rs = this.rsEnd();
    // Closed-loop calibration bookkeeping: the committed render stats total
    // (in CURRENT calibrated units) is what this compile claims the request
    // will cost — reportRealInputTokens compares provider usage against it.
    // rsEnd() returns null only for a pass that began no tally, and
    // selectAdaptive's rsBegin() at its top always begins one, so the guard
    // answers rsEnd()'s type.
    this._storeView = store;
    if (rs) {
      this._lastCompileEstimate =
        rs.head.tokens + rs.tail.tokens + rs.middleRaw.tokens +
        rs.summaries.l1.tokens + rs.summaries.l2.tokens + rs.summaries.l3.tokens;
      this._calibrationArmed = true; // exactly one sample per compile
    }
    return merged;
  }

  private _lastCompileEstimate = 0;
  private _storeView: MessageStoreView | null = null;

  /** Thinking the context manager left out after this strategy's committing
   *  select priced it isn't sent, so the calibration sample's estimate leaves
   *  out what this strategy priced it at: each block at the store's estimate.
   *  The select priced each raw message's thinking blocks at just that: the
   *  image strip and the cap that also enter a message's price never change
   *  a thinking block's. */
  noteThinkingLeftOut(blocks: readonly ContentBlock[]): void {
    if (blocks.length === 0) return;
    const tokens = this.estimateTokens([...blocks]);
    if (Number.isFinite(tokens) && tokens > 0) this._lastCompileEstimate = Math.max(0, this._lastCompileEstimate - tokens);
  }

  /** Whether the select in progress is for a model that binds thinking
   *  (`SelectOptions.thinkingBinding`): set from the select's own option for
   *  the run of its select path, and false outside it. A summary's carriers
   *  were minted in its summarizer's request, so such a model never takes
   *  them in the live window, and the live window renders and prices them as
   *  under `carrierPolicy: 'live-strip'`. */
  private thinkingBound = false;

  /** The carrier policy the live window renders and prices under: the
   *  configured one, or `'live-strip'` while thinking is bound. */
  private liveCarrierPolicy(): CarrierPolicy {
    return this.thinkingBound || this.config.carrierPolicy === 'live-strip' ? 'live-strip' : 'full';
  }

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
    const current = this._calibration;
    const observed = ratio * current; // back out the multiplier already applied
    // SANITY BAND: a representative sample sits near 1. Anything wilder is a
    // structural mismatch (a request we didn't compile, a partial compile, a
    // provider quirk) — never evidence about chars-per-token. Log, don't learn.
    // The band is also checked on the IMPLIED raw multiplier: when the
    // multiplier sits at a clamp edge because the per-class rates were wrong
    // (signed thinking at a flat 600) and the rates are then fixed, every
    // honest sample reads real/est ≈ 1/1.8 = 0.56 — out of band on the ratio
    // alone, so the multiplier could never come back down. A sample whose
    // implied multiplier is inside the clamp range is window-shaped by
    // construction and must be learned from.
    const ratioInBand = ratio >= 0.6 && ratio <= 1.8;
    const observedInBand = observed >= 0.6 && observed <= 1.8;
    if (!ratioInBand && !observedInBand) {
      this.diag.error(
        `[estimator-calibration] REJECTED out-of-band sample real/est=${ratio.toFixed(2)} ` +
          `(est=${Math.round(est / 1000)}k real=${Math.round(realTotal / 1000)}k) — ` +
          `not a window-shaped request; multiplier stays ${this._calibration.toFixed(2)}`,
      );
      return;
    }

    const alpha = 0.2; // slow EMA: one wild request shouldn't yank the ruler
    const ema = this._calibrationEma ?? current;
    // A provisional multiplier is a guess (see CALIBRATION_PRICING_EPOCH). This
    // sample is the first evidence under this release's pricing, so it replaces
    // the guess outright; the EMA steps from here on.
    const provisional = this._calibrationProvisional;
    this._calibrationProvisional = null;
    const next = provisional ? observed : ema + alpha * (observed - ema);
    const clamped = Math.min(1.8, Math.max(0.6, next));
    this._calibrationEma = clamped;
    // DEAD BAND. The multiplier is applied only once the EMA has moved more
    // than 2% from the applied value. Every applied change reprices every
    // message and summary, so each structure kept across compiles (kv-unified
    // forest, summary tree, certificate graph, token memos) is rebuilt; a
    // sample per compile moved it by a fraction of a percent every wake and
    // made every compile a cold one.
    // ponytail: fixed 2% band, so estimates may lag the EMA by up to 2%;
    // make it a config value if a host needs a tighter ruler.
    if (Math.abs(clamped - current) / current <= 0.02) {
      // A provisional multiplier confirmed within the band gets its stamp
      // now: the record it came from has none, or is the discard's.
      if (provisional) {
        this.diag.error(
          `[estimator-calibration] real/est=${ratio.toFixed(2)} confirms the provisional multiplier ` +
            `${current.toFixed(2)} (est=${Math.round(est / 1000)}k real=${Math.round(realTotal / 1000)}k); stamped`,
        );
        this.persistCalibration();
      }
      return;
    }
    this.diag.error(
      `[estimator-calibration] real/est=${ratio.toFixed(2)} ` +
        `multiplier ${current.toFixed(2)} -> ${clamped.toFixed(2)}${provisional ? ' (provisional: replaced, not stepped)' : ''} ` +
        `(est=${Math.round(est / 1000)}k real=${Math.round(realTotal / 1000)}k)`,
    );
    this._calibration = clamped;
    this.applyCalibration();
    this.persistCalibration();
  }

  /** Write the multiplier in force under the current pricing stamp, with the
   *  reset it carries and without the provisional flag a discard wrote: this
   *  is the first sample's write, which is what ends the provisional state.
   *  Best-effort, as every calibration write is. */
  private persistCalibration(): void {
    try {
      this.store?.setStateJson(this.calibrationStateId, {
        multiplier: this._calibration,
        at: Date.now(),
        pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH,
        ...(this._calibrationReset ? { reset: this._calibrationReset } : {}),
      });
    } catch { /* persistence is best-effort */ }
  }

  /** Bind the most recently selected kv-unified presentation to a unique
   * provider submission. Compilation alone never advances receipt state. */
  beginKvUnifiedSubmission(args: {
    submissionId: string;
    requestHash: string;
    layoutHash: string;
  }): void {
    this.requireLoadedBranch('beginKvUnifiedSubmission');
    if (this.config.foldingStrategy !== 'kv-unified' || !this.kvUnifiedDraft) {
      throw new Error('No kv-unified presentation draft is available for submission');
    }
    const { superseded } = this.kvUnifiedReceipts.begin({ ...args, leaves: this.kvUnifiedDraft.leaves });
    if (superseded) {
      this.diag.error(
        `[kv-unified] submission ${superseded} was never settled (no usage event before the next ` +
          `provider call); superseded by ${args.submissionId}`,
      );
    }
    this.kvUnifiedPendingLayout = this.kvUnifiedDraft.layout;
    this.kvUnifiedPendingMarkerUnitIndices = [...this.kvUnifiedDraft.markerUnitIndices];
    this.kvUnifiedPendingImmutablePrefixHash = this.kvUnifiedDraft.immutablePrefixHash ?? null;
    this.kvUnifiedPendingRender = this.kvUnifiedDraft.render ?? null;
  }

  isKvUnifiedEnabled(): boolean {
    return this.config.foldingStrategy === 'kv-unified';
  }

  reportKvUnifiedAccepted(args: {
    submissionId: string;
    acceptedAt?: number;
    wireReceipt?: {
      requestHash: string;
      markers: Array<{ ordinal: number; prefixHash: string; estimatedOffset: number }>;
    };
  }): void {
    this.requireLoadedBranch('reportKvUnifiedAccepted');
    if (args.submissionId !== this.kvUnifiedReceipts.inFlightSubmissionId) {
      // A callback for a submission already settled, or superseded by a later
      // one, is a duplicate to the receipt chain, which changes nothing, and
      // the chain refuses any other id. Either way the pending state is left
      // as it is, for the in-flight submission's own callback (what it is when
      // nothing is in flight, reportKvUnifiedFailed says).
      this.kvUnifiedReceipts.accept(args.submissionId, args.acceptedAt ?? Date.now(), null);
      return;
    }
    let cache: ProviderCacheReference | null = null;
    if (
      args.wireReceipt &&
      this.kvUnifiedPendingLayout &&
      this.kvUnifiedPendingImmutablePrefixHash &&
      args.wireReceipt.markers.length === this.kvUnifiedPendingMarkerUnitIndices.length
    ) {
      cache = {
        immutablePrefixHash: this.kvUnifiedPendingImmutablePrefixHash,
        layout: this.kvUnifiedPendingLayout,
        markers: this.kvUnifiedPendingMarkerUnitIndices.map((unitIndex) => ({
          unitIndex,
          offset:
            unitIndex >= this.kvUnifiedPendingLayout!.units.length
              ? this.kvUnifiedPendingLayout!.totalTokens
              : this.kvUnifiedPendingLayout!.units[unitIndex].offset,
        })),
        ...(this.kvUnifiedPendingRender ? { render: this.kvUnifiedPendingRender } : {}),
      };
    } else if (
      args.wireReceipt &&
      args.wireReceipt.markers.length > 0 &&
      this.kvUnifiedPendingLayout &&
      this.kvUnifiedPendingImmutablePrefixHash &&
      !this.kvUnifiedMarkerMismatchReported
    ) {
      // The request carried markers, but not one for each layout boundary its
      // compile reconciled them to, which reconcileKvUnifiedMarkerIndices'
      // contract rules out. A request with none (prompt caching off) has
      // nothing to match.
      this.kvUnifiedMarkerMismatchReported = true;
      const boundaries = this.kvUnifiedPendingMarkerUnitIndices.length;
      this.diag.error(
        `[kv-unified] submission ${args.submissionId}: the request carried ${args.wireReceipt.markers.length} ` +
          `cache markers where its compile marked ${boundaries} layout boundar${boundaries === 1 ? 'y' : 'ies'}, ` +
          `so this presentation keeps no cache reference and the next compile weighs no cache costs ` +
          `(logged once per strategy)`,
      );
    }
    this.kvUnifiedReceipts.accept(
      args.submissionId,
      args.acceptedAt ?? Date.now(),
      cache,
      args.wireReceipt,
    );
    this.kvUnifiedPendingLayout = null;
    this.kvUnifiedPendingMarkerUnitIndices = [];
    this.kvUnifiedPendingImmutablePrefixHash = null;
    this.kvUnifiedPendingRender = null;
    this.persistKvUnifiedReceipts();
  }

  /** Write the receipt chain snapshot (one entry per leaf: 75k entries, ~5 MB
   *  of JSON on a long history). */
  private persistKvUnifiedReceipts(): void {
    this.writeStateJson(this.kvUnifiedReceiptStateId, this.kvUnifiedReceipts.serialize());
  }

  /** JSON state write through the byte setter. Handing the native store a
   *  large JS object makes it walk the graph through napi (~100 ms for 75k
   *  receipt leaves on Bun); JSON.stringify plus the byte setter is ~10 ms
   *  for the same parsed value. The native JSON setter refuses `undefined`,
   *  so no value written today depends on its handling. */
  private writeStateJson(stateId: string, value: unknown): void {
    const store = this.store;
    if (!store) return;
    if (typeof (store as { setState?: unknown }).setState === 'function') {
      store.setState(stateId, storedJson(value));
    } else {
      store.setStateJson(stateId, value);
    }
  }

  reportKvUnifiedFailed(submissionId: string): void {
    this.requireLoadedBranch('reportKvUnifiedFailed');
    const inFlight = submissionId === this.kvUnifiedReceipts.inFlightSubmissionId;
    this.kvUnifiedReceipts.fail(submissionId);
    // As for an acceptance, a callback for any other submission leaves the
    // pending state as it is: the in-flight submission's, or, after an
    // acceptance that threw once the chain had settled its submission, that
    // submission's, which the next begin replaces.
    if (!inFlight) return;
    this.kvUnifiedPendingLayout = null;
    this.kvUnifiedPendingMarkerUnitIndices = [];
    this.kvUnifiedPendingImmutablePrefixHash = null;
    this.kvUnifiedPendingRender = null;
  }

  private _calibrationArmed = false;

  private _calibration = 1;
  /** The EMA itself; `_calibration` is its last applied value (see the dead band). */
  private _calibrationEma: number | null = null;
  private _calibrationLoaded = false;
  /** Set when an older-epoch multiplier was discarded; persisted with the record. */
  private _calibrationReset: CalibrationReset | null = null;
  /** Set while the multiplier is provisional (see CALIBRATION_PRICING_EPOCH):
   *  the first sample the band accepts replaces it outright, and one above 1
   *  that puts a compile over budget is dropped to 1. `fromEpoch` is the
   *  record's it came from, null for one without a stamp. */
  private _calibrationProvisional: { fromEpoch: number | null } | null = null;

  protected applyCalibration(): void {
    this._storeView?.setTokenCalibration?.(this._calibration);
  }

  /**
   * Version of the per-class token pricing the persisted calibration
   * multiplier was learned against. The multiplier is a residual over those
   * rates, so it means nothing once they change: a store that pinned 1.8
   * under the flat-600 signed-thinking price (epoch 0) comes back after the
   * signature-priced fix estimating ~1.8x its real size. If that inflated
   * plan is over the hard budget, the very first compile throws
   * OverBudgetError, so no inference runs, no sample is ever reported, and
   * the band fix in reportRealInputTokens never gets a chance to decay it: a
   * permanent startup wedge. Bump this whenever MessageStore/ContextLog
   * pricing changes shape, and give the new epoch an entry in
   * CALIBRATION_EPOCH_REPRICES.
   *
   *   0: signed thinking at a flat HIDDEN_THINKING_TOKENS_DEFAULT (before 0.11.0)
   *   1: signed thinking priced by signature length (0.11.0 on)
   *   2: membrane's XML-history carriers (tool_attempt, tool_notice) priced as
   *      the markup they replay as, where they had estimated as 0
   *   3: a raw message `maxMessageTokens` cuts priced as it renders, at its
   *      uncapped price plus what the cut changes (cappedPriceExtra), and one
   *      it leaves whole at its uncapped price, where each was priced at no
   *      more than the cap plus 50. The calibration sample compares provider
   *      usage with the render stats, which counted those prices, so a store
   *      holding capped content learned a multiplier that made up for them.
   *   4: a tool result `toolResultMaxLastN` replaces, and a `tool_use` input
   *      `toolUseInputMaxTokens` truncates, priced as sent (toolPruning,
   *      prunedForSend), where the plan and the render stats counted each
   *      whole while the request carried the marker or the truncation. A
   *      store holding either learned a multiplier low enough to make up for
   *      the over-count, or, where the over-count put every sample out of
   *      band, learned nothing from it.
   *   5: generated images (`generated_image`, nested in a tool result too)
   *      priced as an image without a stamp, where they had estimated as 0
   *
   * A record without a stamp was written by 0.13.0 or earlier: by 0.11.0 to
   * 0.13.0 under epoch 1's pricing, or by a release before 0.11.0, under
   * epoch 0's pricing or any before it, which CALIBRATION_EPOCH_REPRICES
   * doesn't model. Nothing in the record tells these apart (#179: five stores
   * upgraded from pre-0.11 runtimes kept a 1.8 pinned under the flat
   * signed-thinking price, folded to ~45% of the window or wedged). So such
   * a multiplier is PROVISIONAL. It is discarded at load if the epochs since
   * 1 repriced content the store holds, or if it sits at a clamp edge (a
   * residual pinned at 1.8 or 0.6 corrected rates that were off by more than
   * the clamp allows, and says nothing about this release's); otherwise it
   * is kept, but not re-stamped. A provisional multiplier above 1 that puts
   * the first compile over budget is dropped to 1 and the select runs again
   * (dropProvisionalCalibration). The first sample the band accepts replaces
   * a provisional multiplier outright, instead of stepping the EMA toward it,
   * and writes the stamp (reportRealInputTokens). The 1 a discard restarts
   * from is provisional too, so one sample sets it rather than about ten; it
   * is persisted as such (`provisional: true`), so a restart before that
   * sample doesn't turn the guess into a learned value, and a later epoch's
   * load re-stamps it, still provisional, rather than discarding it again
   * over the reset it carries. A dry run under a
   * provisional multiplier above 1 takes the same fallback at the picker's
   * refusal, which it otherwise only reports.
   *
   * A binary from before a bump still learns after a rollback, and its first
   * applied sample overwrites the newer epoch's record with its own stamp
   * (reportRealInputTokens); rolling forward again treats that as an older
   * record.
   */
  static readonly CALIBRATION_PRICING_EPOCH = 5;

  /**
   * For each pricing epoch, the content it repriced: a predicate over the
   * store that is true when the store holds any, given the strategy whose
   * config can decide it (epoch 3 reads the cap). A multiplier from an older
   * epoch is discarded only if some epoch since then repriced content this
   * store actually holds. Otherwise its residual still means what it meant
   * (e.g. a store on another provider's tokenizer, which never carries
   * signed thinking), and it is re-stamped instead. An epoch without an
   * entry here counts as repricing everything (discard, as before).
   */
  static readonly CALIBRATION_EPOCH_REPRICES: Readonly<Record<number, (
    messages: readonly StoredMessage[],
    strategy: AutobiographicalStrategy,
    store: MessageStoreView,
  ) => boolean>> = {
    // 1: signed thinking priced by signature length, not a flat 600. A block
    // with a numeric `tokenEstimate` is priced by that stamp in both epochs
    // (MessageStore and ContextLog read it first), so it wasn't repriced.
    1: (messages) => messages.some((m) => m.content.some((b) => {
      const block = b as { type?: string; signature?: unknown; tokenEstimate?: unknown };
      return block.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0 &&
        typeof block.tokenEstimate !== 'number';
    })),
    // 2: XML-history carriers, which estimated as 0 before (an unknown block)
    // and are now priced by MessageStore.xmlHistoryCarrierTokens.
    2: (messages) => messages.some((m) => m.content.some((b) => MessageStore.xmlHistoryCarrierTokens(b) > 0)),
    // 3: a raw message the cap cuts, or one it leaves whole whose price the
    // cap plus 50 had limited, under the host's cap. Whether the cap looks is
    // the cut's own estimate passing it. Whether the old price limited a
    // message depends on the multiplier it was priced under, so this asks
    // whether its estimate could have passed the cap plus 50 at the clamp's
    // ceiling of 1.8, bounded from its estimate at the applied multiplier.
    // The store rounds each top-level block's estimate on its own, so that
    // estimate is within half a token a block of the applied multiplier
    // times the blocks' unrounded sum, and at the ceiling each block's
    // rounding adds up to half a token more. The bound covers both, so with
    // the multiplier the store estimates at it is never under the estimate
    // at the ceiling, and a store it counts in wrongly restarts from 1,
    // which one sample sets. A view that doesn't report its multiplier as a
    // positive finite number is read at the clamp's floor, 0.6, the lowest
    // this strategy applies, so the bound stays above the estimate at the
    // ceiling for whichever it applied. Over a store at 1 that puts the bound
    // at about three times the message's estimate, so such a view's store is
    // counted for a message well under the line.
    3: (messages, strategy, store) => {
      const cap = strategy.config.maxMessageTokens;
      if (!(typeof cap === 'number' && cap > 0)) return false;
      const applied = store.getTokenCalibration?.();
      const factor = typeof applied === 'number' && Number.isFinite(applied) && applied > 0 ? applied : 0.6;
      return messages.some((m) => {
        if (strategy.estimateTextOnlyTokens(m) > cap) return true;
        const rounding = 0.5 * m.content.length;
        return (1.8 * (store.estimateTokens(m) + rounding)) / factor + rounding > cap + 50;
      });
    },
    // 4: a tool result the per-tool limit replaces, or a tool_use input over
    // the input cap, under the host's config: both were priced whole before.
    // So were the results a per-tool limit in a map that isn't a number
    // replaced before, when it was read by arithmetic (a null as 0, a "2" as
    // 2, true as 1); now it sets no limit. A store discards where a tool's
    // limit, read the same way, is a number of 0 or more (a negative one was
    // skipped) below the number of its calls answered, as the count pairs
    // them (answeredToolCalls); for a number, that's where the count
    // replaces. A value that reads as no number, such as undefined, a
    // non-numeric string, or the function a tool named like an Object member
    // finds, replaced nothing, and keeps.
    4: (messages, strategy, store) => {
      const pruning = strategy.toolPruning(store);
      if (pruning.replaced.size > 0) return true;
      const limits = strategy.config.toolResultMaxLastN as Record<string, unknown> | number | null | undefined;
      if (typeof limits === 'object' && limits !== null) {
        for (const [toolName, answered] of answeredToolCalls(messages)) {
          const limit = limits[toolName];
          // A value Number() can't read, such as a symbol or an object with
          // no way to a primitive, threw at that arithmetic too.
          let read = NaN;
          try { read = Number(limit); } catch { /* read stays NaN, and keeps */ }
          if (read >= 0 && read < answered.length) return true;
        }
      }
      if (!(pruning.inputCap > 0)) return false;
      return messages.some((m) => m.content.some((b) => b.type === 'tool_use' && truncatedToolUse(b, pruning.inputCap) !== null));
    },
    // 5: generated images, which estimated as 0 before (an unknown block) and
    // are now priced as an image, wherever MessageStore prices them.
    5: (messages) => messages.some((m) => {
      for (const image of imagesIn(m.content)) if (image.type === 'generated_image') return true;
      return false;
    }),
  };

  /** Whether any epoch in (fromEpoch, CALIBRATION_PRICING_EPOCH] repriced content in this store. */
  protected calibrationRepricedSince(fromEpoch: number, messages: readonly StoredMessage[], store: MessageStoreView): boolean {
    for (let e = fromEpoch + 1; e <= AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH; e++) {
      const reprices = AutobiographicalStrategy.CALIBRATION_EPOCH_REPRICES[e];
      if (!reprices || reprices(messages, this, store)) return true;
    }
    return false;
  }

  /** Load the persisted multiplier once and push it into the store view.
   *  A multiplier from an older epoch is re-stamped if no content this store
   *  holds was repriced since, and otherwise discarded (start at 1), unless
   *  it's a provisional restart, which is re-stamped either way. One from
   *  a record without a stamp is kept as provisional, or discarded when it
   *  sits at a clamp edge (see CALIBRATION_PRICING_EPOCH). One from a newer
   *  epoch is not used.
   *  A dry select's load decides the same way from the record and the store
   *  as they are, and the rest of its select prices by that decision (its
   *  chunking ran before the load, at the store's factor then, as a
   *  committing select's does), but it writes and logs nothing. select()
   *  then puts back everything the load changed, the multiplier the store
   *  prices by included, so the first committing select loads again, from
   *  the record and the store as they are by then, and logs and persists
   *  what it decides. */
  protected loadCalibration(store: MessageStoreView, opts: { dryRun: boolean }): void {
    this._storeView = store;
    if (!this._calibrationLoaded) {
      this._calibrationLoaded = true;
      const commit = !opts.dryRun;
      // A load decides from the record and the store alone: an earlier dry
      // load of this branch may have left its own decision in these.
      this._calibration = 1;
      this._calibrationReset = null;
      this._calibrationProvisional = null;
      try {
        const saved = this.store?.getStateJson(this.calibrationStateId) as
          { multiplier?: number; pricing?: number; reset?: CalibrationReset; provisional?: boolean } | null;
        if (saved && Number.isFinite(saved.multiplier)) {
          const current = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
          const stamped = typeof saved.pricing === 'number' && Number.isFinite(saved.pricing);
          // No stamp: written by 0.13.0 or earlier, under epoch 1's pricing or
          // any before it (see CALIBRATION_PRICING_EPOCH). The reprice check
          // can only be asked about the epochs since 1; the rest is what makes
          // such a multiplier provisional.
          const epoch = stamped ? saved.pricing! : 1;
          const fromEpoch = stamped ? epoch : null;
          const pinned = saved.multiplier! >= 1.8 || saved.multiplier! <= 0.6;
          const repriced = epoch < current && this.calibrationRepricedSince(epoch, store.getAll(), store);
          if (epoch === current) {
            this._calibration = Math.min(1.8, Math.max(0.6, saved.multiplier!));
            this._calibrationReset = isCalibrationReset(saved.reset) ? saved.reset : null;
            // A discard's 1 that no sample has confirmed yet was persisted as
            // provisional, and stays a guess across the restart: the first
            // sample still sets it, instead of stepping toward it.
            if (saved.provisional === true) {
              this._calibrationProvisional = { fromEpoch: this._calibrationReset?.fromEpoch ?? null };
            }
          } else if (epoch < current && stamped && (!repriced || saved.provisional === true)) {
            // Kept and re-stamped, for one of two reasons. Nothing this store
            // holds was repriced since that epoch, so the residual is still
            // valid. Or the record is a restart no sample has confirmed: every
            // writer of a provisional record persists the 1 it restarted from,
            // beside the reset that records what it replaced, so it holds
            // nothing learned under the older pricing for a reprice to make
            // stale, and discarding it again would only overwrite that reset.
            // A reset the record carries is this store's history and stays
            // with it, as it does through the learner's writes, and so does a
            // provisional flag: a discard's 1 that no sample has confirmed is
            // still a guess.
            this._calibration = Math.min(1.8, Math.max(0.6, saved.multiplier!));
            this._calibrationReset = isCalibrationReset(saved.reset) ? saved.reset : null;
            if (saved.provisional === true) {
              this._calibrationProvisional = { fromEpoch: this._calibrationReset?.fromEpoch ?? null };
            }
            if (commit) {
              this.diag.warn(
                repriced
                  ? `[estimator-calibration] kept the provisional multiplier ${this._calibration.toFixed(2)} from pricing ` +
                    `epoch ${epoch} (current ${current}): a restart that no provider sample has confirmed holds nothing ` +
                    `learned under that epoch's pricing, so this store's content repriced since doesn't discard it; ` +
                    `re-stamped, still provisional`
                  : `[estimator-calibration] kept multiplier ${this._calibration.toFixed(2)} from pricing epoch ${epoch} ` +
                    `(current ${current}): this store holds no content repriced since then; re-stamped`,
              );
              try {
                this.store?.setStateJson(this.calibrationStateId, {
                  multiplier: this._calibration,
                  at: Date.now(),
                  pricing: current,
                  ...(this._calibrationReset ? { reset: this._calibrationReset } : {}),
                  ...(this._calibrationProvisional ? { provisional: true } : {}),
                });
              } catch { /* persistence is best-effort */ }
            }
          } else if (repriced || (epoch < current && !stamped && pinned)) {
            const reset: CalibrationReset = { discardedMultiplier: saved.multiplier!, fromEpoch, at: Date.now() };
            this._calibrationReset = reset;
            // The 1 this restarts from is a guess too: the first sample sets it.
            this._calibrationProvisional = { fromEpoch };
            if (commit) {
              const why = stamped
                ? `learned under pricing epoch ${epoch} (current ${current}), in a store holding content repriced since`
                : !repriced
                  ? `from a record with no pricing stamp (0.13.0 or earlier), pinned at the ` +
                    `${saved.multiplier! >= 1.8 ? 'ceiling' : 'floor'} of its clamp: it corrected per-class rates ` +
                    `that were off by more than the clamp allows, and says nothing about this release's`
                  : `from a record with no pricing stamp (0.13.0 or earlier), in a store holding content ` +
                    `repriced since (current epoch ${current})`;
              this.diag.warn(
                `[estimator-calibration] DISCARDED multiplier ${saved.multiplier!.toFixed(2)} ${why}; ` +
                  `restarting from 1.00. Every token estimate changes by ${(1 / saved.multiplier!).toFixed(2)}x, ` +
                  `and the window refolds to match; the first provider sample within the calibration's sanity band sets the multiplier outright. ` +
                  `If the old value is still accurate for this store (e.g. it mostly corrects for a ` +
                  `non-Anthropic tokenizer), check it against provider-billed input tokens and re-stamp it: ` +
                  `setStateJson('${this.calibrationStateId}', { multiplier, at, pricing: ${current} }). ` +
                  `Shown as calibration.reset in render stats until then.`,
              );
              // Persist the reset, so a rollback to a binary that ignores the
              // stamp can't reload the stale multiplier and re-arm the wedge,
              // and the discard isn't re-logged on every restart. The 1 is
              // persisted as provisional until the first sample's write.
              try {
                this.store?.setStateJson(this.calibrationStateId,
                  { multiplier: 1, at: Date.now(), pricing: current, reset, provisional: true });
              } catch { /* persistence is best-effort */ }
            }
          } else if (epoch < current) {
            // No stamp, not pinned, and nothing the epochs since 1 repriced:
            // the multiplier may be epoch 1's and still right, or older and
            // stale, and the record can't say. Keep it as provisional, and
            // write nothing: the stamp is the first sample's to give.
            this._calibration = Math.min(1.8, Math.max(0.6, saved.multiplier!));
            this._calibrationReset = isCalibrationReset(saved.reset) ? saved.reset : null;
            this._calibrationProvisional = { fromEpoch: null };
            if (commit) {
              this.diag.warn(
                `[estimator-calibration] kept multiplier ${this._calibration.toFixed(2)} from a record with no ` +
                  `pricing stamp (0.13.0 or earlier) as provisional: the first provider sample replaces it ` +
                  `outright, and a compile it puts over budget drops it to 1.00 first. Stamped (epoch ` +
                  `${current}) once a sample confirms it.`,
              );
            }
          }
          // A record from a NEWER epoch belongs to a later binary. The load
          // leaves it on disk and doesn't use it, and logs nothing, since
          // re-stamping it as the discard warning advises would destroy it.
          // This binary's learner still writes its own record over it on its
          // first applied sample (see CALIBRATION_PRICING_EPOCH).
        }
      } catch { /* absent slot is fine */ }
    }
    // A dry select changes the store's multiplier only where select() read it
    // first and can put it back (see MessageStoreView).
    if (opts.dryRun && store.setTokenCalibration && !store.getTokenCalibration) {
      throw new Error(
        'A dry select needs a store view that reads its token calibration (getTokenCalibration) ' +
          'as well as setting it, so the multiplier it applies can be put back afterwards.',
      );
    }
    this.applyCalibration();
  }

  /** The fallback for a provisional multiplier above 1 whose compile was
   *  refused (see CALIBRATION_PRICING_EPOCH): discard it to 1, so the select
   *  can run again, and record the reset; a committing select logs and
   *  persists it, a dry one keeps it to itself (select() puts it back).
   *  Returns false when there is nothing to drop: no provisional multiplier,
   *  or one at or below 1, where raising estimates can't help, so the refusal
   *  stands. The 1 stays provisional: the first sample sets it. */
  protected dropProvisionalCalibration(err: OverBudgetError, dryRun: boolean): boolean {
    const provisional = this._calibrationProvisional;
    if (!provisional || this._calibration <= 1) return false;
    const current = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const discarded = this._calibration;
    const reset: CalibrationReset = { discardedMultiplier: discarded, fromEpoch: provisional.fromEpoch, at: Date.now() };
    this._calibration = 1;
    this._calibrationReset = reset;
    this.applyCalibration();
    if (dryRun) return true;
    this.diag.warn(
      `[estimator-calibration] DISCARDED provisional multiplier ${discarded.toFixed(2)} ` +
        `(${provisional.fromEpoch === null ? 'from a record with no pricing stamp' : `from pricing epoch ${provisional.fromEpoch}`}): ` +
        `the compile priced by it was refused (${err.actual} tokens against a hard budget of ${err.budget}); ` +
        `restarting from 1.00 and compiling again. The first provider sample sets the multiplier outright. ` +
        `Shown as calibration.reset in render stats.`,
    );
    try {
      this.store?.setStateJson(this.calibrationStateId,
        { multiplier: 1, at: Date.now(), pricing: current, reset, provisional: true });
    } catch { /* persistence is best-effort */ }
    return true;
  }

  /**
   * Per-entry cache identities (participant + content bytes) of the last
   * request this strategy returned, used to find the measured stable-prefix
   * boundary, which the fold diff also reports. A select that throws puts the
   * previous ones back (select). In-memory only: after a restart the first
   * compile falls back to seam placement.
   */
  protected _prevCacheKeys?: string[];

  /**
   * The markers each three-slot request placed: its first slot, whether that
   * was the deep band's end rather than the head, and every index it marked.
   * Keyed by that request's cache keys array, so it goes back wherever
   * `select` puts `_prevCacheKeys` back (a refused select, a dry run), and a
   * baseline set any other way carries none. Weak keys keep no earlier
   * request alive.
   */
  private readonly placedMarks = new WeakMap<readonly string[], { first: number; band: boolean; marks: readonly number[] }>();

  /**
   * Index of the last entry of the deep band: the leading run, immediately
   * after the head, of recall pairs rendered at the deepest summary level
   * emitted in `[lastHead+1, historyEnd]`. A recall pair is its Context
   * Manager question (no source id, no layout key) followed by the answer
   * carrying `cacheLayoutKey = summary id`; a layout key that resolves to no
   * summary (merged raw shards carry their last message id) is raw, and so
   * stops the run. A keyless entry joins the run only when an answer at the
   * deepest level follows it, as a pair's question does, so a band normally
   * starts with its question.
   *
   * The run starts after the entries right after the head that hold only
   * repair stubs `enforceToolPairing` generated, for a head that ends in a
   * tool_use whose result isn't next. Such an entry renders the same on every
   * compile while the head ends in that call and no genuine result for it is
   * within `enforceToolPairing`'s look-ahead, so the band behind it stands as
   * one right after the head would. Once a genuine result comes within
   * reach, `enforceToolPairing` moves it into that place, so the entry after
   * the head is no longer stubs alone. It is no recall pair either, so there
   * is no band and the first slot falls back to the head. Only generated
   * stubs pass, by identity (`generatedToolResultStubs`), not an entry shaped
   * like one.
   *
   * Returns -1 when no summary is emitted or the run is empty.
   *
   * The level is the deepest over the whole middle, not the leading run's
   * own. Deliberately conservative: when a shallower leading run sits in
   * front of a deeper summary, the window is not in the canonical
   * oldest-is-deepest shape — the older content is the part the solver has
   * left shallower, so it is the part a merge or re-cut is still due to
   * change — and a run due to be rewritten is no band.
   * Then there is no band and the first slot falls back to the head, which
   * is never worse than before the band.
   */
  private deepBandEnd(entries: readonly ContextEntry[], lastHead: number, historyEnd: number): number {
    const levelAt = (i: number): number | undefined => {
      const key = entries[i]?.cacheLayoutKey;
      if (!key) return undefined;
      return this.summaryById(key)?.level;
    };
    let maxLevel = 0;
    for (let i = lastHead + 1; i <= historyEnd; i++) {
      const lvl = levelAt(i);
      if (lvl !== undefined && lvl > maxLevel) maxLevel = lvl;
    }
    if (maxLevel === 0) return -1;
    const isRepairStub = (e: ContextEntry): boolean =>
      e.content.length > 0 && e.content.every((block) => this.generatedToolResultStubs.has(block));
    let i = lastHead + 1;
    while (i <= historyEnd && isRepairStub(entries[i]!)) i++;
    let end = -1;
    while (i <= historyEnd) {
      const lvl = levelAt(i);
      if (lvl === maxLevel) { end = i; i++; continue; }
      const e = entries[i]!;
      const isQuestion =
        lvl === undefined && !e.sourceMessageId && !e.cacheLayoutKey &&
        i + 1 <= historyEnd && levelAt(i + 1) === maxLevel;
      if (isQuestion) { i++; continue; }
      break;
    }
    return end;
  }

  /**
   * Place message-level `cache_control` breakpoints across the final ordered
   * entries. `kv-unified` owns all four provider slots and uses rendered-token
   * thirds of non-tail history plus the tail end. Other strategies retain the
   * legacy three-slot contract: first slot, measured stable-prefix boundary,
   * and end. Their first slot is the end of the deep band (`deepBandEnd`)
   * when the compile emitted one, else the last head message.
   *
   * The trade on membrane's native formatter: native puts a cache marker on
   * the system block only when ZERO message markers arrive. So there the
   * head marker was the one marker whose prefix (tools+system+head) stayed
   * byte-identical turn to turn, and every turn read at least that from
   * cache. With the first marker at the band's end instead, a turn whose
   * band changes inside it (a merge one level up, or the solver re-cutting
   * the band's youngest group to a shallower level) reads from cache on
   * native only a prefix an earlier request marked within what survived,
   * which is usually none, so it usually reads NOTHING — before, it read
   * tools+system+head. On the XML formatter membrane marks the system
   * block itself on these requests (its default `cacheMarkers:
   * 'membrane-system'`, which agent-framework leaves in place for every
   * strategy but kv-unified), so a band change still reads tools+system there.
   * The head marker bought little (244 tokens on Fable) against the band
   * (~73k), so the trade is taken; it pays off where changes inside the band
   * are rarer than folds after it.
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
   * Returns the index of this compile's first entry whose bytes differ from
   * the previous compile's entry at the same position, or that has none there
   * (the first appended one): the measurement behind the stable-prefix mark,
   * which the fold diff reports. It is the entry count only when these
   * entries are the previous compile's or a prefix of them, and null with no
   * earlier compile to compare or no entries.
   *
   * Clears any pre-existing markers first. It records these entries' keys for
   * the next compile to compare with, so a second call on the same entries
   * returns their count.
   */
  protected placeCacheMarkers(
    entries: ContextEntry[],
    headMessageIds: ReadonlySet<MessageId>,
    tailMessageIds: ReadonlySet<MessageId>,
  ): number | null {
    for (const e of entries) if (e.cacheMarker) e.cacheMarker = false;
    const n = entries.length;
    if (n === 0) return null;

    // Measured stable prefix: first index where this compile's entry bytes
    // diverge from the previous compile's. Measured for every strategy, since
    // the fold diff reports it; kv-unified places its markers without it.
    const keys = entries.map(
      (e) => `${e.participant}\0${JSON.stringify(e.content)}`,
    );
    let firstDiff = n;
    const prev = this._prevCacheKeys;
    if (prev) {
      let i = 0;
      while (i < n && i < prev.length && keys[i] === prev[i]) i++;
      firstDiff = i;
    }
    this._prevCacheKeys = keys;
    const firstChanged = prev ? firstDiff : null;

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
    const historyEnd = firstTail - 1; // last non-tail entry

    if (this.config.foldingStrategy === 'kv-unified') {
      // CM owns all four slots in kv-unified mode. Place three history
      // breakpoints at the nearest legal rendered-token boundaries to
      // 33%/66%/100%, plus one at the end of the tail. There is deliberately
      // no separate early/system marker: every history prefix already
      // includes tools, system, and the raw head on the provider wire.
      //
      // A marker can go only where an entry ends a solved layout unit, since
      // reconcileKvUnifiedMarkerIndices records it as that unit's boundary.
      // The layout renders the head as one unit, so an entry that ends on a
      // head message is a boundary only when no later entry holds a head
      // message. That is the head's last entry, or no entry when a body that
      // the head and the recent window share runs on past the head's end. A
      // tool-result repair spliced in between head messages holds none, so
      // the test looks past it to the last entry that does. The head's
      // entries come first, and an entry holds consecutive messages, so an
      // entry holds a head message exactly when its first source is one.
      let lastHeadEntry = -1;
      for (let index = 0; index < n; index++) {
        const first = entries[index]!.sourceMessageIds?.[0] ?? entries[index]!.sourceMessageId;
        if (first !== undefined && headMessageIds.has(first)) lastHeadEntry = index;
      }
      const isBoundary = (index: number): boolean => {
        const entry = entries[index]!;
        if (!(entry.cacheLayoutKey || entry.sourceMessageId || entry.sourceMessageIds?.at(-1))) return false;
        const last = lastSourceOf(entry);
        return !(last !== undefined && headMessageIds.has(last) && index < lastHeadEntry);
      };
      const marks = new Set<number>();
      if (historyEnd >= 0) {
        const cumulative: number[] = [0];
        for (let i = 0; i <= historyEnd; i++) {
          cumulative.push(
            cumulative[cumulative.length - 1]! +
            Math.max(1, this.estimateTokens(entries[i]?.content ?? [])),
          );
        }
        const legalBoundaries = entries
          .slice(0, historyEnd + 1)
          .flatMap((_, index) => (isBoundary(index) ? [index] : []));
        const nearestBoundary = (fraction: number): number => {
          const target = cumulative[cumulative.length - 1]! * fraction;
          let best = legalBoundaries[0]!;
          for (const index of legalBoundaries.slice(1)) {
            if (
              Math.abs(cumulative[index + 1]! - target) <
              Math.abs(cumulative[best + 1]! - target)
            ) best = index;
          }
          return best;
        };
        if (legalBoundaries.length > 0) {
          marks.add(nearestBoundary(1 / 3));
          marks.add(nearestBoundary(2 / 3));
          marks.add(legalBoundaries.at(-1)!);
        }
      }
      let tailEnd = -1;
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if (entry.cacheLayoutKey || entry.sourceMessageId || entry.sourceMessageIds?.at(-1)) {
          tailEnd = index;
          break;
        }
      }
      if (tailEnd >= 0) marks.add(tailEnd);
      if (marks.size > 4) {
        throw new Error(
          `placeCacheMarkers: ${marks.size} caller-owned markers exceed Anthropic's limit of 4`,
        );
      }
      for (const idx of marks) entries[idx]!.cacheMarker = true;
      return firstChanged;
    }

    // The measured stable prefix's last entry. No previous compile → seam
    // placement, the old bounded cold-start behavior. Later pure appends mark
    // the previous endpoint itself so reuse never depends on Anthropic finding
    // it within the new end marker's 20-block backward-search window.
    const stableEnd = prev ? firstDiff - 1 : historyEnd;

    // The deep band: the leading run of recall pairs after the head (and after
    // any repair stubs there), rendered at the deepest level this compile
    // emitted. Nothing that arrives rewrites it: a new max-level summary lands
    // after the run, and a merge one level up is the rare exception (one event
    // per mergeThreshold landings at that level). A deeper summary landing
    // after it ends the band without changing a byte of it, and the measured
    // slot below then keeps the previous request's furthest unchanged mark.
    // The solver can still re-cut the band's youngest group to a shallower
    // level when the budget no longer needs it (kv-stable's ideal cut; #156
    // reduces those re-cuts), and
    // `Picker.run` applies whatever the solver returns — so this is the
    // cheapest stable prefix after system+tools, not an immutable one. It is
    // what the head marker was standing in for: on Fable (2026-10-06) the head
    // marker cached 244 tokens of bootstrap messages while 14 complete L3
    // pairs (~73k) sat unmarked behind it, and 24 of 51 large rewrites in a
    // week re-read exactly the system+tools prefix.
    // -1 when no summary was emitted or the run is empty.
    const deepBandEnd = this.deepBandEnd(entries, lastHead, historyEnd);
    // The previous request's markers, read before this one's are recorded.
    const prevPlaced = prev ? this.placedMarks.get(prev) : undefined;

    const marks = new Set<number>();
    // First slot: the end of the deep band when there is one, else the head.
    // The band comes after the head, so the prefix through the band's end
    // contains the head and extends what the head marker cached, for as
    // long as the band stands (the doc comment says what a change inside the
    // band costs). A band end that just moved keeps this slot too, so the
    // next request can read it.
    const first = deepBandEnd >= 0 ? deepBandEnd : lastHead;
    if (first >= 0) marks.add(first);                  // system+deep band / head
    // Measured slot: the last entry of the measured stable prefix, except on a
    // compile where the first slot moves with a band before or after it (the
    // band forms, deepens, shrinks or goes). Then it marks the furthest entry
    // the previous request marked that is still in the unchanged prefix, such
    // as the head when a fold forms the band right after it, the old band end
    // on a deepen or when the band goes, or the previous request's measured or
    // end marker when the change comes after it. Membrane's XML formatter
    // packs the conversation into one text block between markers (images
    // aside), so a cache entry there is read back only through a marker on
    // the same entry, and the move would otherwise leave unread what the
    // previous request wrote. When that entry is the new first slot, or
    // nothing the previous request marked is still unchanged, the measured
    // slot marks the stable prefix as before. A move with no band on either
    // side, as when the head window moves, leaves the measured slot at the
    // stable prefix too.
    let measured = stableEnd > lastHead ? stableEnd : -1;
    if (prevPlaced && prevPlaced.first !== first && (prevPlaced.band || deepBandEnd >= 0)) {
      const kept = Math.max(-1, ...prevPlaced.marks.filter((m) => m <= stableEnd));
      if (kept >= 0 && kept !== first) measured = kept;
    }
    if (measured >= 0) marks.add(measured);            // measured stable prefix (the big one)
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

    this.placedMarks.set(keys, { first, band: deepBandEnd >= 0, marks: [...marks] });
    for (const idx of marks) if (idx >= 0 && idx < n) entries[idx].cacheMarker = true;
    return firstChanged;
  }

  /** Convert emitted message markers back to atomic solver-layout boundaries,
   * each to the one where its entry ends. Folded recall pairs and the middle's
   * raw shard runs carry `cacheLayoutKey` on the entry that ends the unit. Any
   * other entry ends on the message it holds last (`lastSourceOf`, so a merged
   * body on its last shard): a head message maps to the single synthetic head
   * unit, which placeCacheMarkers marks only on the entry that ends the head,
   * and any other message to its own unit, or a recent one without one to the
   * opaque tail block. Every wire marker must reconcile exactly. */
  protected reconcileKvUnifiedMarkerIndices(
    entries: readonly ContextEntry[],
    layout: RenderLayout,
    headMessageIds: ReadonlySet<MessageId>,
    tailMessageIds: ReadonlySet<MessageId>,
  ): number[] {
    const indices: number[] = [];
    for (const entry of entries) {
      if (!entry.cacheMarker) continue;
      const sourceId = lastSourceOf(entry);
      const atomicKey = entry.cacheLayoutKey ?? sourceId;
      // A tail message is its own raw unit (render-offsets `tailUnits`); the
      // opaque 'tail' block only carries tail tokens no chunk accounts for.
      const layoutKey = sourceId && headMessageIds.has(sourceId)
        ? 'head'
        : sourceId && tailMessageIds.has(sourceId)
          ? (atomicKey && layout.units.some((unit) => unit.key === atomicKey) ? atomicKey : 'tail')
          : atomicKey;
      if (!layoutKey) {
        throw new Error('kv-unified cache marker has no atomic layout identity');
      }
      let matched = -1;
      for (let i = 0; i < layout.units.length; i++) {
        if (layout.units[i].key === layoutKey) matched = i + 1;
      }
      if (matched <= 0) {
        throw new Error(`kv-unified cache marker layout key ${layoutKey} is absent from the solved layout`);
      }
      if (!indices.includes(matched)) indices.push(matched);
    }
    return indices;
  }

  /** The draft's render record (CacheRenderRecord), from the entries this
   *  compile emits: for each marked entry, in order, its identity and the hash
   *  of every entry up to it. Reconcile refuses a marked entry with no
   *  identity, and acceptance keeps a reference only when the wire carried one
   *  marker per reconciled unit, while it carries one per marked entry. So an
   *  accepted reference's prefixes run parallel to its markers, and the check
   *  credits one whose don't as it is. */
  private kvUnifiedRenderRecord(
    entries: readonly ContextEntry[],
    layout: RenderLayout,
    rebuilt: KvUnifiedRebuilt | null,
  ): CacheRenderRecord {
    const compare = rebuilt && !this.kvUnifiedSelfCheckWarned && this.kvUnifiedKeepsPresentation(layout, rebuilt.layout)
      ? rebuilt
      : null;
    const marked: { through: string; hash: string }[] = [];
    const sent = new Map<string, string>();
    for (const prefix of this.kvUnifiedPrefixHashes(entries, (entry) =>
      entry.cacheMarker === true || (compare?.wanted.has(this.kvUnifiedIdentity(entry)!) ?? false))) {
      if (prefix.entry.cacheMarker === true) marked.push({ through: prefix.through, hash: prefix.hash });
      if (compare?.wanted.has(prefix.through)) sent.set(prefix.through, prefix.hash);
    }
    if (compare) this.kvUnifiedSelfCheck(compare, sent);
    return { prefixes: marked };
  }

  /** Whether a layout keeps the reference's presentation: the reference's
   *  units, by kind and key, or the first of them where the newest messages
   *  were removed, then a raw unit for each newer chunk. A newer chunk shown
   *  folded doesn't keep it: the rebuild renders newer messages raw, and
   *  pairing repair can move a raw newer message's late tool result into an
   *  earlier call's stub slot, which the emission, folding that message,
   *  leaves a stub. An earlier image they leave alike either way: the strip
   *  gives each image the verdict postStripEstimates gave it, whether its
   *  message is folded or raw (applyImageStripping's asEstimated). */
  private kvUnifiedKeepsPresentation(layout: RenderLayout, kept: RenderLayout): boolean {
    return layout.units.every((unit, i) =>
      i < kept.units.length
        ? unit.kind === kept.units[i]!.kind && unit.key === kept.units[i]!.key
        : unit.kind === 'raw');
  }

  /** The check's rebuild renders the continuation that keeps the
   *  reference's presentation, so where this compile kept it, the rebuild
   *  must hash each marked prefix as this compile sent it. A difference is
   *  the rebuild's: one that renders a message differently drops markers the
   *  provider would serve, and one that misses a change the emission made,
   *  such as a pass it lacks, credits a prefix that changed. Said once per
   *  instance, naming where they first differ, after which the instance
   *  stops comparing. */
  private kvUnifiedSelfCheck(rebuilt: KvUnifiedRebuilt, sent: Map<string, string>): void {
    const through = [...rebuilt.wanted].find((id) => rebuilt.hashes.get(id) !== sent.get(id));
    if (through === undefined) return;
    this.kvUnifiedSelfCheckWarned = true;
    this.diag.warn(
      `[kv-unified] the cache check rebuilt the prefix through ${through} differently from what this compile ` +
        `sent with the accepted presentation kept, so its credit can be wrong until the rebuild ` +
        `(kvUnifiedKeepEntries) matches the emission`,
    );
  }

  /** The accepted cache reference as this compile's solver should credit it.
   *  What renders under an unchanged unit key can differ from the request
   *  that cached it: an edit, an image stripped, a tool result replaced by
   *  last-N or moved by pairing repair, a message or a recall answer cut, a
   *  recall's envelope or label. A provider serves a marker's prefix only
   *  while every byte before it is unchanged. So this rebuilds the entries of
   *  the continuation that keeps the reference's presentation, with what its
   *  recall units don't cover raw (kvUnifiedKeepEntries), and
   *  leaves out each marker whose prefix there no longer hashes as it was
   *  sent, or whose entry it can't find. The record comes from what was sent
   *  and only the check rebuilds, so a rebuild that renders a message
   *  differently at every compile drops markers rather than crediting them,
   *  while one that misses a change the emission makes, such as a pass it
   *  lacks, credits the changed prefix. Where a compile keeps the reference's
   *  presentation, its record compares the two (kvUnifiedSelfCheck). A
   *  candidate that renders a newer message differently from the reference,
   *  folded where it was raw or raw where it was folded, can change an
   *  earlier call's slot, since pairing repair moves a raw message's late
   *  tool result into its call's stub slot. The rebuild keeps the reference's
   *  presentation, so it doesn't see that change, and credits the markers
   *  past the slot, which over-credits them (#295). Images take no part: the
   *  strip gives each image the verdict postStripEstimates gave it, whether
   *  its message is folded or raw and wherever the repair moves it
   *  (applyImageStripping's asEstimated). A reference without a record that describes its markers,
   *  such as one an earlier version wrote, is credited as it is. A marker on
   *  the reference's head unit stands for the head's end, so it holds only
   *  while its message ends this compile's head window. */
  private kvUnifiedCacheForSolve(
    store: MessageStoreView,
    messages: readonly StoredMessage[],
    window: { headStart: number; headEnd: number; recentStart: number; msgCap: number },
  ): { cache: ProviderCacheReference | null; rebuilt: KvUnifiedRebuilt | null } {
    const cache = this.kvUnifiedReceipts.cache;
    const prefixes = cache?.render?.prefixes;
    // No marker to leave out, or no record that describes the markers.
    if (
      !cache || cache.markers.length === 0 || !Array.isArray(prefixes) || prefixes.length !== cache.markers.length ||
      !prefixes.every((prefix) => typeof prefix?.through === 'string' && typeof prefix.hash === 'string')
    ) return { cache, rebuilt: null };
    const entries = this.kvUnifiedKeepEntries(store, messages, cache, window);
    const wanted = new Set(prefixes.map((prefix) => prefix.through));
    const now = new Map(
      this.kvUnifiedPrefixHashes(entries, (entry) => wanted.has(this.kvUnifiedIdentity(entry)!))
        .map((prefix) => [prefix.through, prefix.hash]),
    );

    const headLast = window.headEnd > window.headStart ? messages[window.headEnd - 1]?.id : undefined;
    const markers = cache.markers.filter((marker, i) => {
      const { through, hash } = prefixes[i]!;
      if (cache.layout.units[marker.unitIndex - 1]?.kind === 'head' && through !== headLast) return false;
      return now.get(through) === hash;
    });
    return {
      cache: markers.length === cache.markers.length
        ? cache
        : { immutablePrefixHash: cache.immutablePrefixHash, layout: cache.layout, markers },
      rebuilt: { layout: cache.layout, wanted, hashes: now },
    };
  }

  /** Adds to `into` the messages a summary covers, through its sources down
   *  to the L1s, whose sources (sourceLevel 0) are messages. `seen` walks
   *  each summary once; a summary that no longer exists covers nothing. */
  private kvUnifiedLeaves(id: string, into: Set<string>, seen: Set<string>): void {
    if (seen.has(id)) return;
    seen.add(id);
    const summary = this.summaryById(id);
    if (!summary) return;
    for (const source of summary.sourceIds) {
      if (summary.sourceLevel === 0) into.add(source);
      else this.kvUnifiedLeaves(source, into, seen);
    }
  }

  /** The entries the continuation that keeps the reference's presentation
   *  would emit, as selectAdaptive emits them, after the passes that run on
   *  them before markers are placed. The windows are this compile's.
   *  Outside the head window, a message renders folded when one of the
   *  reference's recall units covers it (kvUnifiedLeaves) and it wasn't a
   *  raw unit, and raw otherwise: the reference's raw units, and what no
   *  recall unit of it covers, which is what came after it or has left the
   *  head window since. Membership rather than position decides, so
   *  removing messages, newest ones included, leaves the rest classed as
   *  the reference had them. Where a run of folded messages starts, the
   *  emission puts the run's recall pairs, so the rebuild puts there the
   *  recall pair of each recall unit the reference's layout has after the
   *  raw unit before it and with a message still present, as the emission
   *  renders it (recallPairEntries). Raw messages are cut by cappedForSend;
   *  a body's raw shards in the middle join their text into one entry, as
   *  the middle's shard path does, and shards in the head and recent
   *  windows join through mergeAdjacentBodyGroupRaw. */
  private kvUnifiedKeepEntries(
    store: MessageStoreView,
    messages: readonly StoredMessage[],
    cache: ProviderCacheReference,
    window: { headStart: number; headEnd: number; recentStart: number; msgCap: number },
  ): ContextEntry[] {
    const keptRaw = new Set<string>();
    const folded = new Set<string>();
    // A recall unit none of whose messages remain renders nowhere, in the
    // emission as here.
    const present = new Set(messages.map((m) => m.id));
    const rendered = new Set<string>();
    for (const unit of cache.layout.units) {
      if (unit.kind === 'raw') keptRaw.add(unit.key);
      else if (unit.kind === 'recall') {
        const leaves = new Set<string>();
        this.kvUnifiedLeaves(unit.key, leaves, new Set());
        for (const id of leaves) {
          folded.add(id);
          if (present.has(id)) rendered.add(unit.key);
        }
      }
    }
    const raw = (i: number): boolean => keptRaw.has(messages[i]!.id) || !folded.has(messages[i]!.id);
    // Each recall unit, under the raw unit before it in the layout ('' for none).
    const recallAfter = new Map<string, string[]>();
    let anchor = '';
    for (const unit of cache.layout.units) {
      if (unit.kind === 'raw') anchor = unit.key;
      else if (unit.kind === 'recall' && rendered.has(unit.key)) {
        const keys = recallAfter.get(anchor);
        if (keys) keys.push(unit.key);
        else recallAfter.set(anchor, [unit.key]);
      }
    }
    const entries: ContextEntry[] = [];
    const pushRaw = (msg: StoredMessage): void => {
      entries.push({
        index: entries.length, sourceMessageId: msg.id, sourceRelation: 'copy', participant: msg.participant,
        content: this.cappedForSend(store, msg, window.msgCap).content,
      });
    };
    let pending: readonly string[] = recallAfter.get('') ?? [];
    const afterRaw = (id: string): void => {
      pending = recallAfter.get(id) ?? [];
    };
    const pushFolded = (): void => {
      for (const key of pending) {
        // Pending holds only recall units with a message present, so the summary exists.
        const summary = this.summaryById(key)!;
        // A pair this can't render is left out, so the markers past it don't
        // match and are dropped, rather than the check refusing the compile.
        try {
          entries.push(...this.recallPairEntries(summary, window.msgCap, entries.length));
        } catch (error) {
          if (!this.kvUnifiedRecallRenderWarned) {
            this.kvUnifiedRecallRenderWarned = true;
            this.diag.warn(
              `[kv-unified] the cache check couldn't render recall ${summary.id} ` +
                `(${error instanceof Error ? error.message : String(error)}); the markers past it aren't credited`,
            );
          }
        }
      }
      pending = [];
    };
    for (let i = window.headStart; i < window.headEnd && i < messages.length; i++) pushRaw(messages[i]!);
    const segments: ReadonlyArray<readonly [number, number]> = window.headStart > 0
      ? [[0, window.headStart], [window.headEnd, window.recentStart]]
      : [[window.headEnd, window.recentStart]];
    for (const [segStart, segEnd] of segments) {
      let i = segStart;
      while (i < segEnd && i < messages.length) {
        const msg = messages[i]!;
        if (msg.bodyGroupId) {
          const groupStart = i;
          i = bodyEnd(Math.min(segEnd, messages.length), (k) => messages[k]!, groupStart) + 1;
          let run: { parts: string[]; ids: string[] } | null = null;
          const flush = (): void => {
            if (!run) return;
            entries.push({
              index: entries.length, sourceMessageIds: run.ids, cacheLayoutKey: run.ids.at(-1),
              sourceRelation: 'copy', participant: msg.participant, content: [{ type: 'text', text: run.parts.join('') }],
            });
            run = null;
          };
          for (let k = groupStart; k < i; k++) {
            const shard = messages[k]!;
            if (!raw(k)) {
              flush();
              pushFolded();
              continue;
            }
            run ??= { parts: [], ids: [] };
            run.ids.push(shard.id);
            for (const block of shard.content) if (block.type === 'text') run.parts.push(block.text);
            afterRaw(shard.id);
          }
          flush();
          continue;
        }
        if (raw(i)) {
          pushRaw(msg);
          afterRaw(msg.id);
        } else pushFolded();
        i++;
      }
    }
    for (let i = Math.max(window.recentStart, window.headEnd); i < messages.length; i++) pushRaw(messages[i]!);
    const merged = this.mergeAdjacentBodyGroupRaw(entries, store, messages as StoredMessage[]);
    this.postProcessToolEntries(merged);
    // As selectAdaptive strips, whose emission this rebuilds.
    this.applyImageStripping(merged, store, { asEstimated: true });
    return merged;
  }

  /** The identity of an entry a marker can sit on: the message it ends on,
   *  or its layout key, as reconcileKvUnifiedMarkerIndices reads it. */
  private kvUnifiedIdentity(entry: ContextEntry): string | undefined {
    return lastSourceOf(entry) ?? entry.cacheLayoutKey;
  }

  /** For each entry `marks` picks, in order, its identity and the hash of
   *  every entry up to it, each by its participant and whole content, raw
   *  replay forms included. */
  private kvUnifiedPrefixHashes(
    entries: readonly ContextEntry[],
    marks: (entry: ContextEntry) => boolean,
  ): { through: string; hash: string; entry: ContextEntry }[] {
    const prefixes: { through: string; hash: string; entry: ContextEntry }[] = [];
    const sent = createHash('sha256');
    for (const entry of entries) {
      sent.update(`${this.kvUnifiedEntryFingerprint(entry)}\n`);
      const through = this.kvUnifiedIdentity(entry);
      if (through !== undefined && marks(entry)) prefixes.push({ through, hash: sent.copy().digest('hex'), entry });
    }
    return prefixes;
  }

  /** An entry's fingerprint: its participant and its content's hash. An
   *  entry whose content is its message's own, as most are, costs a lookup. */
  private kvUnifiedEntryFingerprint(entry: ContextEntry): string {
    const content = this.kvUnifiedHash(entry.content, () =>
      sha256Json(entry.content.map((block) => this.kvUnifiedHash(block, () => sha256Json(block)))));
    return `${JSON.stringify(entry.participant)}:${content}`;
  }

  private kvUnifiedHash(object: object, compute: () => string): string {
    let hash = this.kvUnifiedHashes.current.get(object);
    if (hash === undefined) {
      hash = this.kvUnifiedHashes.previous.get(object) ?? compute();
      this.kvUnifiedHashes.current.set(object, hash);
    }
    return hash;
  }

  /**
   * Walk an entries array; for every run of consecutive entries that
   *  (a) have sourceRelation: 'copy' (raw, not a synthesized recall pair)
   *  (b) have sourceMessageId pointing to messages in the same bodyGroup
   * merge them into one composite entry whose body is the byte-faithful
   * concatenation of their text content. Other entries pass through.
   *
   * The merge prices nothing: the head and recent windows priced each shard
   * as they emitted it, as the plan priced it, so the budget and the render
   * stats count a composite as the parts it joins, where the store's default
   * estimator would price the joined text at its first 2,000 characters'
   * rate. What re-estimates entries from their content after this, to place
   * kv-unified's cache markers, report the fold diff or record the rendered
   * layout, reads the joined text.
   *
   * `messages` is the caller's `store.getAll()` listing; overrides should
   * forward it, since a filtered view re-lists the whole history per call.
   *
   * Reindexes the returned array.
   */
  protected mergeAdjacentBodyGroupRaw(
    entries: ContextEntry[],
    store: MessageStoreView,
    messages: ReturnType<MessageStoreView['getAll']> = store.getAll(),
  ): ContextEntry[] {
    if (entries.length === 0) return entries;

    // Look up bodyGroup metadata by sourceMessageId, memoized for the
    // duration of this pass. Entries reference the same messages repeatedly
    // (the run-extension checks below), and store.get() also resolves
    // blobs — fetch each message at most once.
    // Read the metadata off the full listing (the caller's, so a filtered
    // view is not listed twice) instead of one `store.get()` per raw entry:
    // each get re-fetched the record from chronicle and resolved its blobs — ~0.7 s per compile on a 75k-message
    // store (2026-09-21 profile), for two scalar fields. Only sharded
    // messages carry a bodyGroupId, so the index stays small.
    const shardMeta = new Map<string, { groupId?: string; shardIndex?: number }>();
    for (const m of messages) {
      if (m.bodyGroupId) shardMeta.set(m.id, { groupId: m.bodyGroupId, shardIndex: m.shardIndex });
    }
    const metaOf = (sourceMessageId?: string): { groupId?: string; shardIndex?: number } | undefined =>
      sourceMessageId ? shardMeta.get(sourceMessageId) : undefined;
    const groupOf = (sourceMessageId?: string): string | undefined =>
      metaOf(sourceMessageId)?.groupId;
    const shardOf = (entry: ContextEntry) => {
      const meta = metaOf(entry.sourceMessageId);
      return meta ? { bodyGroupId: meta.groupId, shardIndex: meta.shardIndex } : undefined;
    };

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
      // Collect the run of consecutive raw entries of the same body. Another
      // ingestion of the same text shares the group id but restarts its
      // shard indices, and a window can start mid-body: the run ends where an
      // index doesn't rise (see body-runs.ts).
      const end = bodyEnd(entries.length, (k) => (entries[k]!.sourceRelation === 'copy' ? shardOf(entries[k]!) : undefined), i);
      const run: ContextEntry[] = entries.slice(i, end + 1);
      const j = end + 1;
      if (run.length === 1) {
        out.push({ ...entry, index: out.length });
        i++;
        continue;
      }
      // Head and tail emission keep store order, so the run's shards are
      // already in rising shard order (body-runs.ts).
      // Build merged text content. Every shard's non-text blocks are kept,
      // ahead of the text: chunkIngressMessage puts a body's on its first
      // shard, so they are that shard's.
      const mergedTextParts: string[] = [];
      const nonTextBlocks: ContentBlock[] = [];
      for (const r of run) {
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
        sourceMessageId: run[0].sourceMessageId,
        // Keep every shard's id: this composite represents all of them, and
        // the coverage invariant reads provenance, not just the first source.
        sourceMessageIds: run
          .map(e => e.sourceMessageId)
          .filter((id): id is string => !!id),
        sourceRelation: 'copy',
        participant: run[0].participant,
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
    this._adaptivePicker = new Picker(strategy, this.diag);
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
    immutablePrefixHash?: string,
    continuityRelaxation?: SelectOptions['kvUnifiedContinuityRelaxation'],
  ): Picker {
    // Drift alarm: the live config must still name the solver chosen at
    // construction. Nothing legitimate rewrites foldingStrategy at runtime —
    // a mismatch means an override merge (or other mutation) clobbered it,
    // and THIS compile is about to run under the wrong cache policy. The
    // 2026-08-07 fable investigation found exactly one such compile
    // ([picker-unrealizable] solver=flat-profile in a kv-stable agent) with
    // no way to attribute it; this line is the attribution.
    if (this.config.foldingStrategy !== this._constructedFoldingStrategy) {
      this.diag.error(
        `[picker-config-drift] foldingStrategy=${JSON.stringify(this.config.foldingStrategy)} ` +
          `differs from constructed=${JSON.stringify(this._constructedFoldingStrategy)} — ` +
          `a runtime mutation clobbered the solver choice; this compile runs the wrong solver`,
        new Error('picker-config-drift stack').stack,
      );
    }
    if (this.config.foldingStrategy === 'kv-stable') {
      const strategy = new KvStableStrategy({
        diagnostics: this.diag,
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
      return new Picker(strategy, this.diag);
    }
    if (this.config.foldingStrategy === 'kv-unified') {
      const configured = this.config.kvUnified;
      if (!configured) {
        throw new Error(
          'foldingStrategy "kv-unified" requires a complete kvUnified configuration; live defaults are forbidden',
        );
      }
      const strategy = new KvUnifiedStrategy({
        ...configured,
        // Ages are read in geometric bands unless the recipe's policy says
        // otherwise (ageBandSteps: 0 prices exact ages); the solver treats an
        // absent value as exact.
        policy: { ...configured.policy, ageBandSteps: configured.policy?.ageBandSteps ?? 4 },
        // The certified hysteresis exit is on unless the recipe says
        // `hysteresisCertificate: false`. It only skips the full solve when it
        // proves the carried layout is the policy's choice, and declines to
        // the full solver otherwise, so the default changes solve time, not
        // the eligibility, adoption or fallback rules.
        hysteresisCertificate: configured.hysteresisCertificate ?? true,
        reuse: this.kvUnifiedReuse,
        continuityMultiplier: this.kvUnifiedContinuityMultiplier(continuityRelaxation),
        latentDemand: {
          mergeThreshold: this.config.mergeThreshold ?? 6,
          fallbackRecallTokens: Math.max(1, (this.config.summaryTargetTokens ?? 2_000) + 20),
          maxCandidates: 16,
          // One what-if solve for the whole candidate set unless the recipe
          // asks for the per-candidate ranking; the solver treats an absent
          // mode as individual.
          mode: configured.latentDemandMode ?? 'joint',
          // A quarantined merge is refused at the queue (enqueueMerge), so
          // it is not a candidate: measured, it could carry the gain and,
          // in joint mode, hide the merge the cut would otherwise use.
          blocked: (sourceIds) => this.mergeQuarantine.has(sha256Json(sourceIds)),
        },
        ...(this.kvUnifiedReceipts.head
          ? {
              presentation: {
                currentSeq: this.kvUnifiedReceipts.head.sequence,
                leaves: this.kvUnifiedReceipts.leaves,
              },
            }
          : {}),
        ...(this.kvUnifiedSolveCache ? { cache: this.kvUnifiedSolveCache } : {}),
        ...(immutablePrefixHash ? { currentImmutablePrefixHash: immutablePrefixHash } : {}),
        requireExplicitPolicy: true,
        // A solve past the label ceiling takes the minimum-token cut (#252),
        // in any pick: the live one, a dry run's, a production-budget shadow
        // pick or an attempt a retry replaces. The recipe's ceiling or grid is
        // the remedy in the operator's hands, so the first such solve in this
        // strategy's life is said where the operator reads, whichever pick it
        // was in; [plan-vs-actual] marks each compile whose own pick took it.
        onCeilingFallback: (hit) => {
          if (this.kvUnifiedCeilingWarned) return;
          this.kvUnifiedCeilingWarned = true;
          this.diag.warn(
            `[kv-unified] labelCeiling ${hit.ceiling} exceeded at ${hit.labels} labels (engine: ${hit.engine}); ` +
              `that solve took the minimum-token cut, as each one that exceeds it will. A high enough labelCeiling ` +
              `lets this forest's search fit, and larger bucket sizes may (said once; [plan-vs-actual] shows ` +
              `ceiling=live for each compile whose own solve did)`,
          );
        },
      });
      this._lastKvUnified = strategy;
      this._lastKvStable = null;
      return new Picker(strategy, this.diag);
    }
    this._lastKvStable = null;
    this._lastKvUnified = null;
    return this.getAdaptivePicker();
  }

  /** Validate the audited transition input at the last possible boundary.
   * Any malformed, unknown, or expired relaxation restores the normal weight. */
  protected kvUnifiedContinuityMultiplier(
    relaxation?: SelectOptions['kvUnifiedContinuityRelaxation'],
  ): number {
    if (!relaxation) return 1;
    const validReason =
      relaxation.reason === 'surgery' ||
      relaxation.reason === 'budget-transition' ||
      relaxation.reason === 'infrastructure';
    const validMultiplier =
      Number.isFinite(relaxation.multiplier) &&
      relaxation.multiplier >= 0 &&
      relaxation.multiplier <= 1;
    const active =
      Number.isFinite(relaxation.expiresAt) &&
      (relaxation.multiplier === 1 || relaxation.expiresAt > Date.now());
    if (!validReason || !validMultiplier || !active) {
      this.diag.warn('[kv-continuity-relaxation] invalid or expired input; continuity remains at 1');
      return 1;
    }
    this.diag.error(
      `[kv-continuity-relaxation] reason=${relaxation.reason} ` +
      `multiplier=${relaxation.multiplier} expiresAt=${new Date(relaxation.expiresAt).toISOString()}`,
    );
    return relaxation.multiplier;
  }

  /** The kv-stable strategy instance behind the most recent compile — kept for
   *  `[kv-escalation]` and `[kv-overlap]` observability (design §13.4: every
   *  override is loud; §13.6). */
  private _lastKvStable: KvStableStrategy | null = null;
  private _lastKvUnified: KvUnifiedStrategy | null = null;
  /** Whether a kv-unified solve, in any pick, has exceeded its label ceiling
   *  yet in this strategy's life: the first one is warned of (#252). */
  private kvUnifiedCeilingWarned = false;
  /** Structures kv-unified may derive from across compiles (validated on use). */
  private readonly kvUnifiedReuse: KvUnifiedReuse = {};
  /** Level pins kv-unified holds below their level, by pin id, as last
   *  reported (`reportHeldLevelPins`). */
  private readonly heldLevelPins = new Map<string, { label: string; level: number }>();

  /**
   * Say when kv-unified holds a level pin below its level (`heldLevelPin`),
   * from what each compile finds on the loaded branch (a dry run reports
   * nothing, since a preview isn't the live state):
   * one line when a compile first finds the pin held, naming it, its level,
   * the levels its messages are held at and how many are held then, and one
   * when a later compile finds none of its messages held for it (its level
   * arrived over them, another pin's bound took them, they left the folded
   * middle, or the store no longer holds an end the pin names) or the pin
   * gone. A pin covers what `pinPositions` says, as it
   * does for the forest: under adaptive resolution, a message stored in parts
   * whole when its ids name one of its parts, less a part locked outside the
   * span they name. A message counts once however many of its parts are held.
   * A part counts toward a pin only when that pin's level is the one its
   * bound took (`resolvedPinBounds`). The record starts over with each open
   * and branch switch (`clearBranchMirrors`), so a pin still held then is
   * reported again. It reports what the solve found,
   * before the frontier is presented: a compile the solver refuses reports
   * nothing, since its error names the cause, and one refused after the
   * solve, such as over budget, has already reported the holds its solve made.
   */
  private reportHeldLevelPins(forest: CanonicalSummaryForest, messages: StoredMessage[]): void {
    const held = new Map<MessageId, { level: number; heldAt: number }>();
    if (this.pins.some((pin) => pin.level !== undefined && pin.level > 0)) {
      for (const leaf of forest.orderedLeaves()) {
        const hold = heldLevelPin(leaf);
        if (hold) held.set(leaf.id, hold);
      }
    }
    const now = new Map<string, { label: string; level: number; heldAt: Set<number>; count: number }>();
    if (held.size > 0) {
      const positionOf = this.positionIndex(messages);
      for (const pin of this.pins) {
        if (pin.level === undefined || pin.level <= 0) continue;
        const covered = this.pinPositions(pin, positionOf, messages);
        if (covered === undefined) continue;
        const heldAt = new Set<number>();
        // Held messages, each by its first position: a message's parts are one.
        const bodies = new Set<number>();
        for (const i of covered) {
          const hold = held.get(messages[i].id);
          if (!hold || hold.level !== pin.level) continue;
          heldAt.add(hold.heldAt);
          bodies.add(bodyBoundsIn(messages, i).from);
        }
        const label = pin.name ? `${pin.id} ("${pin.name}")` : pin.id;
        if (bodies.size > 0) now.set(pin.id, { label, level: pin.level, heldAt, count: bodies.size });
      }
    }
    const levelName = (level: number): string => (level === 0 ? 'raw' : `L${level}`);
    for (const [id, pin] of now) {
      if (this.heldLevelPins.has(id)) continue;
      this.heldLevelPins.set(id, { label: pin.label, level: pin.level });
      this.diag.warn(
        `autobio: kv-unified holds pin ${pin.label}, pinned at L${pin.level}, at ` +
          `${[...pin.heldAt].sort((a, b) => a - b).map(levelName).join(' and ')} in ${pin.count} message(s): ` +
          `no summary supplies L${pin.level} over them yet. They move to L${pin.level} once one does.`,
      );
    }
    for (const [id, pin] of this.heldLevelPins) {
      if (now.has(id)) continue;
      this.heldLevelPins.delete(id);
      this.diag.warn(
        this.pins.some((p) => p.id === id)
          ? `autobio: kv-unified no longer holds pin ${pin.label} below its L${pin.level}.`
          : `autobio: pin ${pin.label}, held below its L${pin.level} by kv-unified, was removed.`,
      );
    }
  }

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
        case 'image':
        case 'generated_image': {
          // Estimate parity with the renderer's flat image cost. An image is
          // payload a summary can't carry, so it counts as fully externalized,
          // wherever its bytes sit: an image's in a blob, at a URL or inline,
          // a generated image's always inline. A generated image goes to the
          // provider as an image and is priced as one.
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

  /** Memoized price of a summary's recall answer as the LIVE WINDOW renders
   *  it (carriers included under `carrierPolicy: 'full'`, omitted under
   *  `'live-strip'` or while thinking is bound, as liveCarrierPolicy says,
   *  because this price feeds the fold planner for that same
   *  emission): `estimate` is the estimate of that content, and `cost` is
   *  what it's priced at, the estimate floored at the provider's measurement
   *  where that measurement counts what's sent. Keyed by the summary identity
   *  and every config value that changes these bytes, so a scoped preview
   *  cannot reuse or poison another policy's price. The estimator is the
   *  store's: every caller prices inside a select, with the store's view
   *  bound, and initialize clears the memo when the strategy takes a store. */
  private _answerCostCache = new Map<string, { estimate: number; cost: number }>();

  protected recallAnswerCost(s: SummaryEntry): { estimate: number; cost: number } {
    const recallEnvelope = this.config.recallEnvelope === 'xml' ? 'xml' : 'none';
    const carrierPolicy = this.liveCarrierPolicy();
    const calibration = this._storeView?.getTokenCalibration?.() ?? 1;
    const key = JSON.stringify([s.id, s.tokens, recallEnvelope, carrierPolicy, calibration]);
    const cached = this._answerCostCache.get(key);
    if (cached !== undefined) return cached;
    const estimate = this.estimateTokens(this.liveWindowAnswerContent(s));
    // When responseContent exists, `tokens` is normally the provider's exact
    // output-token count for those same replayed blocks (thinking carriers +
    // text). Re-estimating signed-empty thinking at the 600-token legacy
    // fallback threw that exact measurement away and under-priced Mythos's 65
    // selected recalls by 78k tokens. Keep the estimate as a floor for older
    // entries whose `tokens` predates responseContent capture or was inferred
    // from text, but never replace a larger provider measurement with it.
    //
    // That measurement counts the carriers, so it is a floor only under
    // `carrierPolicy: 'full'`, where the live window emits them. Under
    // `'live-strip'` the carriers never reach the window: pricing them there
    // would charge the fold planner for bytes that are not rendered — the
    // Mica-2026-07-26 wedge from the other side — so the stripped render's
    // estimate stands alone.
    const cost =
      carrierPolicy === 'full' && s.responseContent && Number.isFinite(s.tokens) && s.tokens > 0
        ? Math.max(s.tokens, estimate)
        : estimate;
    const priced = { estimate, cost };
    this._answerCostCache.set(key, priced);
    return priced;
  }

  /** The true render cost of a summary's recall pair: its label, and its
   *  answer as recallAnswerCost prices it. */
  protected recallPairCost(s: SummaryEntry): number {
    const label = this.config.summaryContextLabel ?? 'What do you remember from earlier?';
    return this.estimateTokens([{ type: 'text', text: label }]) + this.recallAnswerCost(s).cost;
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
    chunksByMessageId: Pick<ReadonlyMap<MessageId, Chunk>, 'get'>,
    summariesById?: ReadonlyMap<string, SummaryEntry>,
    /** Fold-path fallback (see selectAdaptive): message → covering L1 id
     *  from L1 sourceIds, for released/boundary-drifted chunk records.
     *  MUST be passed wherever the planner used the same fallback, or the
     *  emitter renders raw what the plan priced folded (emission refusal). */
    l1Fallback?: ReadonlyMap<MessageId, SummaryId>,
    /** Per-compile memo of the walk from a start summary to its ancestor at
     *  a level; every message under the same L1 shares it. */
    memo?: Map<SummaryId, (SummaryEntry | null | undefined)[]>,
    /** The message's chunk record when the caller already holds it (null
     *  for none); undefined looks it up. */
    knownChunk?: Chunk | null,
  ): SummaryEntry | null {
    if (level <= 0) return null;
    const chunk = knownChunk === undefined ? chunksByMessageId.get(messageId) : knownChunk ?? undefined;
    const startId = chunk?.summaryId ?? l1Fallback?.get(messageId);
    if (!startId) return null;
    let known = memo?.get(startId);
    if (known) {
      const cached = known[level];
      if (cached !== undefined) return cached;
    } else if (memo) {
      memo.set(startId, known = []);
    }
    const lookup = (id: string): SummaryEntry | undefined =>
      summariesById ? summariesById.get(id) : this.summaries.find((s) => s.id === id);
    let current: SummaryEntry | undefined = lookup(startId);
    while (current && current.level < level) {
      const parentId = getSummaryParentId(current);
      if (!parentId) { current = undefined; break; }
      current = lookup(parentId);
    }
    const found = current && current.level === level ? current : null;
    if (known) known[level] = found;
    return found;
  }

  /**
   * What tick's chunk request represents by recall pairs, for the messages
   * pins keep raw before the chunk (`forceRawMessageIds`, empty for none): the
   * recall frontier, unsorted; the messages of the L1s a pin opens; and the
   * covered message ids: the leaves of every L1 except those a pin opens, and
   * of every summary in the frontier, whether or not tick sends a recall
   * pair for each. A covered message is never sent raw. compressionWorkQueued's
   * count reads this coverage with the pins before the chunk, so the raw it
   * checks for tool blocks is the raw tick's request carries, or more where
   * tick lays its history out without the pins.
   */
  protected recallCoverage(forceRawMessageIds: ReadonlySet<MessageId>): {
    frontier: SummaryEntry[];
    openedMessageIds: Set<MessageId>;
    coveredMessageIds: Set<MessageId>;
  } {
    const summariesById = new Map<string, SummaryEntry>();
    for (const s of this.summaries) summariesById.set(s.id, s);
    const holdsForceRaw = (summary: SummaryEntry): boolean => {
      if (forceRawMessageIds.size === 0) return false;
      const leaves = new Set<MessageId>();
      this.expandSummaryToLeafMessageIds(summary, summariesById, leaves);
      for (const id of leaves) if (forceRawMessageIds.has(id)) return true;
      return false;
    };
    // Skip empty-content summaries as recall pairs: emitting `{type:'text',
    // text:''}` triggers Anthropic 400 "text content blocks must be
    // non-empty", which stalls ALL compression (mirrors the render-path
    // guard + load-drop). They are descended like pinned ones, so their
    // children still represent the span. An empty L1 that holds no pin
    // stays covered.
    const mixedFrontier: SummaryEntry[] = [];
    const openedChunks: SummaryEntry[] = [];
    // Each summary is visited once: a persisted cycle in sourceIds would
    // otherwise recurse until the stack overflows.
    const descended = new Set<string>();
    const descend = (s: SummaryEntry): void => {
      if (descended.has(s.id)) return;
      descended.add(s.id);
      const pinned = holdsForceRaw(s);
      if (!pinned && !!s.content && s.content.trim().length > 0) {
        mixedFrontier.push(s);
        return;
      }
      if (s.level <= 1) {
        if (pinned) openedChunks.push(s);
        return;
      }
      for (const childId of s.sourceIds) {
        const child = summariesById.get(childId);
        if (child) descend(child);
      }
    };
    for (const s of this.summaries) if (!s.mergedInto) descend(s);
    // A pinned message the descent didn't reach (its L1's parent doesn't
    // list it) opens that L1 too, so a pin holds whatever the linkage.
    if (forceRawMessageIds.size > 0) {
      const reached = new Set<MessageId>();
      for (const s of mixedFrontier) this.expandSummaryToLeafMessageIds(s, summariesById, reached);
      for (const s of openedChunks) this.expandSummaryToLeafMessageIds(s, summariesById, reached);
      const unreached = new Set([...forceRawMessageIds].filter((id) => !reached.has(id)));
      if (unreached.size > 0) {
        for (const s of this.summaries) {
          if (s.level === 1 && !openedChunks.includes(s) && s.sourceIds.some((id) => unreached.has(id))) {
            openedChunks.push(s);
          }
        }
      }
    }
    // Leaf message coverage — the rendering authority for the one-to-one
    // invariant: a covered message is represented by its recall pair, never
    // raw. Uses the whole frontier (not tick's budget-capped
    // keptSummaries): a budget-dropped summary doesn't make its raw
    // messages reappear. Expand summary sourceIds down to leaf message IDs
    // — an L2's sourceIds are L1 IDs, not message IDs; a flat walk would
    // miss every message it transitively covers (Bug 10). Every L1 is
    // expanded too, as defense in depth, except the chunks a pin opened.
    const openedMessageIds = new Set<MessageId>();
    for (const l1 of openedChunks) this.expandSummaryToLeafMessageIds(l1, summariesById, openedMessageIds);
    const priorSummaryMessageIds = new Set<MessageId>();
    for (const s of this.summaries) {
      if (s.level === 1) this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }
    for (const id of openedMessageIds) priorSummaryMessageIds.delete(id);
    for (const s of mixedFrontier) {
      this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }
    return { frontier: mixedFrontier, openedMessageIds, coveredMessageIds: priorSummaryMessageIds };
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
    // Recall pairs are priced with the store's estimator, as raw messages are
    // (store.estimateTokens), not the fallback rules: the adaptive path binds
    // the view in loadCalibration. Bound for this select alone, so a mint
    // request's recall pairs (capRecallPairs) price as they did.
    const bound = this._storeView;
    this._storeView = store;
    try {
      return this.selectHierarchicalBound(store, budget);
    } finally {
      this._storeView = bound;
    }
  }

  private selectHierarchicalBound(store: MessageStoreView, budget: TokenBudget): ContextEntry[] {
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

    // Phase 0: Head window — every message sent raw, each cut at the cap as
    // any raw message is (from headStart, not necessarily 0)
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const { content, extra } = this.cappedForSend(store, msg, msgCap);
      // The pruned form's price with its images whole: this selection's
      // strip counts only the images it sends (#219), or, with
      // imageStripHysteresisRatio, applies that option's set, and it prices
      // no image as the placeholder either way.
      const tokens = store.estimateTokens(this.prunedForSend(store, msg)) + extra;
      // The head is sent whole by definition: stopping it mid-window drops
      // messages no summary covers. Refuse honestly beyond grace.
      if (totalTokens + tokens > graceLimit) {
        throw this.overBudgetError(budget, {
          stage: 'Hierarchical emission overran the budget',
          budget: graceLimit,
          actual: totalTokens + tokens,
          // The head is sent whole by definition, and its size is cold
          // configuration (headWindowTokens isn't a hot setting). Besides a
          // larger budget, a head-window reset clears it, which starts a new
          // topic and isn't a lever the list names (OverBudgetClearedBy).
          // Newer messages can shrink a head that holds images, since the
          // image strip takes the oldest images first (maxLiveImages,
          // maxLiveImageBytes, imageStripDepthTokens), but whether they'd
          // strip enough isn't known, so nothing is named for that either.
          clearedBy: [],
          diagnostics: {
            middleCountUnit: 'selection-items',
            deepestLevelKind: 'attempted',
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

    // What the head took, for a refusal in the middle to report as head.
    const headTokens = totalTokens;
    // A refusal in the middle reports the head as head, and the rest of the
    // running total, the refused item included, as middle. It names
    // compression only for work that folds a message the refused prefix
    // holds: the middle's raw messages up to the refused one, and the leaves
    // of the summaries it sends up to there. Work after the refused item
    // can't shrink that prefix, nor can a chunk's compression that only moves
    // raw messages from after a combined pair into it, and the head never
    // folds.
    let summariesById: Map<string, SummaryEntry> | undefined;
    const middleRefusal = (refused: {
      actual: number;
      unit: 'selection-items' | 'raw-messages';
      count: number;
      deepestLevel: number;
      summaries: readonly SummaryEntry[];
      raw: readonly StoredMessage[];
    }): OverBudgetError => {
      summariesById ??= new Map(this.summaries.map((s) => [s.id, s]));
      const prefix = new Set<MessageId>(refused.raw.map((m) => m.id));
      for (const s of refused.summaries) this.expandSummaryToLeafMessageIds(s, summariesById, prefix);
      return this.overBudgetError(budget, {
        stage: 'Hierarchical emission overran the budget',
        budget: graceLimit,
        actual: refused.actual,
        clearedBy: this.compressionWorkQueued(store, 'hierarchical', prefix) ? ['compression'] : [],
        diagnostics: {
          middleCountUnit: refused.unit,
          deepestLevelKind: 'attempted',
          headTokens,
          tailTokens: 0,
          middleTokens: refused.actual - headTokens,
          middleChunkCount: refused.count,
          deepestLevel: refused.deepestLevel,
        },
      });
    };

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
    // that level's budget), not just the overall context budget. Healthy
    // stores reach this state when budget selection drops children of an
    // excluded parent. Interrupted merges can leave many overlapping parents,
    // increasing the repair demand. The allowance bounds redundant summaries
    // competing with the recent window. Exceeding it is a budget observation,
    // not a corruption diagnosis; Phase 3c still completes coverage, and
    // emission refuses the turn if the resulting context cannot fit.
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
        this.diag.warn(
          `[AutobiographicalStrategy] coverage-repair allowance exceeded — ` +
          `skipped ${l2RepairsSkipped} L2 and ${l3RepairsSkipped} L3 re-inclusions ` +
          `(possible causes: tight per-level budgets or overlapping summaries ` +
          `from interrupted merges). Continuing with coverage completion.`,
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
    const positionOf = this.positionIndex(messages);
    // Without adaptive resolution no selector reads a pin's level bound, so
    // every pinned position resolves to raw (resolvedPinBounds).
    const pinnedPositionsSet = this.forceRawPinPositions(messages);
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
        // The middle's summaries and raw messages up to and including item k,
        // less a summary the loop below skips for having no content.
        const prefixOf = (k: number): { summaries: SummaryEntry[]; raw: StoredMessage[] } => ({
          summaries: items.slice(0, k + 1).flatMap((it) => (it.kind === 'summary' && it.summary.content?.trim() ? [it.summary] : [])),
          raw: items.slice(0, k + 1).flatMap((it) => (it.kind === 'pin' ? [it.msg] : [])),
        });

        for (const [k, item] of items.entries()) {
          if (item.kind === 'summary') {
            const summary = item.summary;
            // Defensive: never emit a recall pair for an empty/bugged summary — an
            // empty assistant text block triggers a 400. (Production guards too,
            // but a legacy empty summary may already exist in the store.)
            if (!summary.content || !summary.content.trim()) continue;
            const headerText = this.buildRecallHeader(summary);
            const rendered = this.renderSummaryAnswer(summary, msgCap);
            const questionEntry: ContextEntry = {
              index: entries.length,
              participant: 'Context Manager',
              content: [{ type: 'text', text: headerText }],
              sourceRelation: 'derived',
              summaries: rendered.refs,
            };
            const answerEntry: ContextEntry = {
              index: entries.length + 1,
              participant: summaryParticipant,
              content: rendered.content,
              sourceRelation: 'derived',
              summaries: rendered.refs,
            };
            const pairTokens = this.recallPairCost(summary);
            // Never silently drop a selected representation: everything in
            // this list either covers history (summaries) or IS uncovered
            // history (pins / uncompressed / frontier raw). Emit within
            // grace; refuse the turn beyond it.
            if (totalTokens + pairTokens > graceLimit) {
              throw middleRefusal({
                actual: totalTokens + pairTokens,
                unit: 'selection-items',
                count: items.length,
                deepestLevel: summary.level,
                ...prefixOf(k),
              });
            }
            entries.push(questionEntry);
            entries.push(answerEntry);
            totalTokens += pairTokens;
            this.rsSummary(summary.level, pairTokens, summary.id);
          } else {
            const msg = item.msg;
            const { content, extra } = this.cappedForSend(store, msg, msgCap);
            const tokens = store.estimateTokens(this.prunedForSend(store, msg)) + extra;
            if (totalTokens + tokens > graceLimit) {
              throw middleRefusal({
                actual: totalTokens + tokens,
                unit: 'selection-items',
                count: items.length,
                deepestLevel: 0,
                ...prefixOf(k),
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
        // The summaries the combined pair's answer holds, which a refusal
        // after it counts in its prefix.
        let pairSummaries: SummaryEntry[] = [];
        if (selectedSummaries.length > 0) {
          const contextLabel = this.config.summaryContextLabel ?? 'What do you remember from earlier?';

          // Synthesised summary turns must respect maxMessageTokens. With L1+L2+L3
          // budgets defaulting to 30k each, an unconstrained concatenation can push
          // a single assistant turn past 90k tokens, eating the inference budget
          // and starving recent messages (postmortem 2026-05-04, bug B).
          //
          // Per-summary blocks (verbatim reasoning + text when captured) are
          // concatenated with the legacy '---' separators as interstitial
          // text blocks — signed thinking must ride along here too.
          const combinedRender = this.renderCombinedRecallAnswer(selectedSummaries, msgCap);
          const combined = combinedRender.content;
          const combinedRefs = combinedRender.refs;
          const questionEntry: ContextEntry = {
            index: entries.length,
            participant: 'Context Manager',
            content: [{ type: 'text', text: contextLabel }],
            sourceRelation: 'derived',
            summaries: combinedRefs,
          };
          const answerEntry: ContextEntry = {
            index: entries.length + 1,
            participant: summaryParticipant,
            content: combined,
            sourceRelation: 'derived',
            summaries: combinedRefs,
          };

          // The summaries the answer holds: every one the flat cap left
          // something of, since it passes every carrier through, cut text or
          // not (capContent), and under the xml envelope those its cap
          // admitted, which ends at the first summary it cuts.
          const admittedIds = new Set(combinedRefs.map((ref) => ref.id));
          const admitted = selectedSummaries.filter((s) => admittedIds.has(s.id));
          pairSummaries = admitted;
          // The pair is priced at what goes out: the label, and the answer as
          // the cap left it, with each summary it holds floored as
          // recallAnswerCost floors a positioned pair's answer, so a carrier's
          // measured tokens count here too.
          let floorExcess = 0;
          for (const s of admitted) {
            const { estimate, cost } = this.recallAnswerCost(s);
            floorExcess += cost - estimate;
          }
          const pairTokens = this.estimateTokens(questionEntry.content) +
                             this.estimateTokens(answerEntry.content) + floorExcess;
          // The pair covers history (coverage completion force-includes its
          // claimers whatever the budget), so beyond the grace window the
          // select refuses the turn here, as it refuses a positioned pair,
          // rather than send over the budget or refuse at what follows it.
          if (totalTokens + pairTokens > graceLimit) {
            throw middleRefusal({
              actual: totalTokens + pairTokens,
              unit: 'selection-items',
              count: selectedSummaries.length,
              deepestLevel: selectedSummaries.reduce((deepest, s) => Math.max(deepest, s.level), 0),
              summaries: admitted,
              raw: [],
            });
          }

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
          const { content, extra } = this.cappedForSend(store, msg, msgCap);
          const tokens = store.estimateTokens(this.prunedForSend(store, msg)) + extra;
          if (totalTokens + tokens > graceLimit) {
            // These messages are the UNCOMPRESSED middle — no summary covers
            // them (see the middleRaw construction above). Dropping them
            // removes them from the agent's context with no representation at
            // all, so beyond the grace window the select refuses the turn
            // rather than returning a plausible-looking window.
            throw middleRefusal({
              actual: totalTokens + tokens,
              unit: 'raw-messages',
              count: middleRawSorted.length,
              deepestLevel: 0,
              summaries: pairSummaries,
              raw: middleRawSorted.slice(0, mi + 1).map((entry) => entry.msg),
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
    this.postProcessToolEntries(entries);
    // Strip stale images (this path places no cache markers). Its emission
    // priced every message at the store's full estimate of the form it sends,
    // plus what a maxMessageTokens cut changes, which leaves its images at
    // full price. So it priced no image as the placeholder, and the strip
    // counts only the images it sends, or, with imageStripHysteresisRatio,
    // applies the rule's verdicts (see applyImageStripping's asEstimated).
    // The render stats keep each message at the price emission
    // gave it, a stripped image included.
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
   * record, not lived experience. Drives the L1 instruction (not reading
   * mode's, which has no witnessed variant), the identity reminder of the L1
   * request and of each split-rung piece, and the `witnessed` stamp on the
   * minted summary or quiet-stretch stub (which merge consolidation honors
   * and propagates upward).
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
   * merge instruction. Applied where each request's instruction is built
   * (the L1 chunk's request, each split-rung piece's in buildSub, and the
   * merge's) rather than inside the format functions, so subclass
   * instruction overrides are covered too. See
   * `AutobiographicalConfig.identityReminder` for rationale (identity flip
   * over pure-witness chunks in multi-resident channels).
   *
   * `witnessed`: the target is WHOLLY inherited record (an L1 chunk entirely
   * before witnessedBeforeSequence, or a merge whose every source is
   * witnessed). Such targets use `witnessedIdentityReminder` when one is
   * configured. Every other target uses `identityReminder`, including a
   * mixed one (a chunk that spans the pin, or a merge of inherited and
   * lived sources), whose request shows both kinds of material under the
   * live reminder with no label saying which is which.
   */
  protected applyIdentityReminder(instruction: string, witnessed = false): string {
    const reminder = (witnessed && this.config.witnessedIdentityReminder?.trim())
      ? this.config.witnessedIdentityReminder.trim()
      : this.config.identityReminder?.trim();
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
   * A message's content priced as the store prices a message, with its
   * serialized media replaced on a copy, as runAttempt prepares a request
   * before it is sent. So a data URL is priced as its marker, not its
   * payload.
   */
  protected preparedTokensOf(content: ContentBlock[], ctx: StrategyContext): number {
    const copy = { content: [...content] };
    this.stripSerializedCompressionMedia([copy]);
    return ctx.messageStore.estimateTokens({ content: copy.content } as unknown as StoredMessage);
  }

  /**
   * A stored message's content priced as a compression request sends it: its
   * thinking stripped, as a request's messages are built from raw messages,
   * then priced as prepared (preparedTokensOf). Images count at the store's
   * estimate, though a request's inline image cap can replace some with
   * placeholders.
   */
  protected sentTokensOf(content: ContentBlock[], ctx: StrategyContext): number {
    return this.preparedTokensOf(stripThinkingBlocks(content), ctx);
  }

  /**
   * A stored message's sentTokensOf, kept per message object and guarded, as
   * the store guards its own estimates, by the identity of every block, the
   * store and its calibration: a sharded body's total is read for every
   * chunk of it, and pricing a shard scans its text for data URLs, which
   * read the whole body once per chunk.
   */
  protected sentTokensOfStored(message: StoredMessage, ctx: StrategyContext): number {
    const content = message.content;
    const calibration = ctx.messageStore.getTokenCalibration?.();
    const hit = this.sentTokensByMessage.get(message);
    if (hit && hit.store === ctx.messageStore && hit.calibration === calibration &&
      hit.blocks.length === content.length && hit.blocks.every((block, i) => block === content[i])) {
      return hit.tokens;
    }
    const tokens = this.sentTokensOf(content, ctx);
    this.sentTokensByMessage.set(message, { blocks: content.slice(), store: ctx.messageStore, calibration, tokens });
    return tokens;
  }

  private readonly sentTokensByMessage = new WeakMap<StoredMessage, {
    blocks: readonly ContentBlock[]; store: object; calibration: number | undefined; tokens: number;
  }>();

  /**
   * The one sharded body every given message belongs to, with its total
   * tokens, or null when they don't all belong to one. A body is one
   * ingestion: another ingestion of the same text shares the group id, and
   * counting it too doubled the document (see body-runs.ts). Each message is
   * priced as a compression request sends it (sentTokensOf).
   */
  protected shardedBodyOf(
    ids: Iterable<string>,
    allMessages: readonly StoredMessage[],
    ctx: StrategyContext,
  ): { totalTokens: number } | null {
    const wanted = [...ids];
    const at = allMessages.findIndex((m) => m.id === wanted[0]);
    if (at < 0 || !allMessages[at]!.bodyGroupId) return null;
    const { from, to } = bodyBoundsIn(allMessages, at);
    const messages = allMessages.slice(from, to + 1);
    const inBody = new Set(messages.map((m) => m.id));
    if (!wanted.every((id) => inBody.has(id))) return null;
    // Priced as a compression request sends each message, so a payload that
    // preparation replaces doesn't count toward the reading total.
    let totalTokens = 0;
    for (const m of messages) totalTokens += this.sentTokensOfStored(m, ctx);
    return { totalTokens };
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
    // A chunk of whole messages is no part of a sharded body: answer before
    // listing the store, as every chunk asks.
    if (chunk.messages.length === 0 || !chunk.messages[0]!.bodyGroupId) return null;
    const body = this.shardedBodyOf(chunk.messages.map((m) => m.id), ctx.messageStore.getAll(), ctx);
    if (!body) return null;
    const totalTokens = body.totalTokens;
    // Tokens in this chunk specifically, priced as the body is.
    let chunkTokens = 0;
    for (const m of chunk.messages) {
      chunkTokens += this.sentTokensOfStored(m, ctx);
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
    const positionOf = this.positionIndex(messages);
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
    const headEnd = Math.min(this.getHeadWindowEnd(ctx.messageStore), this.holdBoundary(ctx.messageStore));
    const headMessages = messages.slice(headStart, headEnd);

    // Format head content, truncated to ~2000 tokens (~8000 chars)
    const MAX_HEAD_CHARS = 8000;
    let headContent = '';
    let headReplacements = 0;
    for (const m of headMessages) {
      // Counted as the request sends it: only the message's text blocks
      // reach it, with their serialized media replaced on a copy, so a
      // payload doesn't spend the cap. The request carries the markers, so
      // what was replaced in the head is logged with it below.
      const copy = { content: m.content.filter((block) => block.type === 'text') };
      const replaced = this.stripSerializedCompressionMedia([copy]);
      const entry = `${m.participant}: ${this.extractText(copy.content)}`;
      if (headContent.length + entry.length > MAX_HEAD_CHARS) {
        headContent += '\n\n[...truncated...]';
        break;
      }
      headContent += (headContent ? '\n\n' : '') + entry;
      headReplacements += replaced;
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

    const preparation = this.prepareCompressionRequest(request);
    this.logCompressionPreparation(
      { ...preparation, serializedMediaReplacements: preparation.serializedMediaReplacements + headReplacements },
      'transition',
    );
    const prepared = preparation.request;
    const crossed = (cause?: unknown) => new Error(
      'Transition summary crossed a branch generation; reinitialize before retrying',
      cause === undefined ? undefined : { cause },
    );
    // Preparing the request can run a subclass's prepareCompressionRequest(),
    // so the currency is checked again just before the call: a generation
    // ended there makes no call.
    if (!this.isCompressionBranchCurrent(sourceBranch)) throw crossed();
    let response: NormalizedResponse;
    try {
      response = await this.callProvider(ctx.membrane, prepared);
    } catch (error) {
      // An error on work that lost its currency while the call was out says
      // so, as its result would below. A host's withdrawal
      // (CompressionWithdrawn) keeps its own path on any branch; a
      // cancellation says so with the rest, since the generation's end makes
      // one too.
      if (!isCompressionWithdrawn(error) && !this.isCompressionBranchCurrent(sourceBranch)) throw crossed(error);
      throw error;
    }
    if (!this.isCompressionBranchCurrent(sourceBranch)) throw crossed();
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
   * recent window AND not kept raw by a pin. Returns messages from
   * [0, headStart) ∪ [headEnd, recentStart) minus any position a pin or
   * document mark keeps raw (forceRawPinPositions). A pin with a positive
   * level or cap is compressible where bounds are read (kv-stable and
   * kv-unified, with adaptive resolution: readsPinBounds): it renders at a
   * level, which only a summary can supply.
   */
  protected getCompressibleMessages(store: MessageStoreView, exclude?: Uint8Array): StoredMessage[] {
    const messages = store.getAll();
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);
    const pinned = this.forceRawPinPositions(messages);
    const out: StoredMessage[] = [];
    for (let i = 0; i < recentStart; i++) {
      if (i >= headStart && i < headEnd) continue;
      if (pinned.has(i)) continue;
      if (exclude && exclude[i]) continue;
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
    this.compressionQueueGeneration++;

    // ---- 1. Materialize persisted records (they OWN their messages). ----
    const listing = store.getAll();
    this.refreshStoreOrder(listing);
    // id -> listing index; the same map positions the frontier below.
    const position = listing.length === 0 ? new Map<MessageId, number>() : this._storeOrder;

    const consumed = new Uint8Array(listing.length);
    const byPosition: (Chunk | undefined)[] = new Array(listing.length);
    this._chunkByPosition = { listing, chunks: byPosition };
    // A record resolves to the same message objects at the same positions as
    // last time when the listing only grew (the store keeps message objects
    // until an edit, which replaces them all), so its messages and token sum
    // carry over; only the record's own fields are re-read.
    const calibration = store.getTokenCalibration?.() ?? 1;
    const ignoreSize = !!this.config.attachmentsIgnoreSize;
    const memo = this._recordChunks;
    let reusable = memo !== null && memo.records === this.chunkRecords && memo.calibration === calibration &&
      memo.ignoreSize === ignoreSize && listing.length >= memo.listing.length;
    if (reusable) {
      const prev = memo!.listing;
      for (let i = 0; i < prev.length; i++) if (listing[i] !== prev[i]) { reusable = false; break; }
    }
    const entries: NonNullable<typeof memo>['entries'] = [];
    let orphaned = 0;
    for (let r = 0; r < this.chunkRecords.length; r++) {
      const rec = this.chunkRecords[r];
      const kept = reusable && r < memo!.entries.length ? memo!.entries[r] : null;
      let msgs: StoredMessage[], tokens: number, positions: number[];
      if (kept && kept.record === rec && kept.messages.length === rec.sourceIds.length) {
        ({ messages: msgs, tokens, positions } = kept);
        for (const at of positions) consumed[at] = 1;
        entries.push(kept);
      } else {
        msgs = []; positions = [];
        for (const id of rec.sourceIds) {
          const at = position.get(id);
          if (at === undefined) continue;
          msgs.push(listing[at]);
          consumed[at] = 1;
          positions.push(at);
        }
        tokens = msgs.reduce((sum, m) => sum + (ignoreSize
          ? this.estimateTextOnlyTokens(m)
          : store.estimateTokens(m)), 0);
        entries.push({ record: rec, messages: msgs, tokens, positions });
      }
      if (msgs.length === 0) { orphaned++; continue; }
      const chunk: Chunk = {
        index: this.chunks.length,
        startIndex: -1, // record-derived; filtered-array indices are not meaningful
        endIndex: -1,
        messages: msgs,
        tokens,
        compressed: rec.compressed,
        summaryId: rec.summaryId,
        phaseType: rec.phaseType,
        recordId: rec.id,
      };
      for (const at of positions) byPosition[at] = chunk;
      this.chunks.push(chunk);
    }
    this._recordChunks = { listing, records: this.chunkRecords, calibration, ignoreSize, entries };

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
        this.diag.error(
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
    const holdBlocked = this.holdBlockedIds(store);
    for (const chunk of this.chunks) {
      if (
        !chunk.compressed &&
        !(chunk.recordId && this._overlapBlocked.has(chunk.recordId)) &&
        !this.chunkHasHeldMessage(chunk, holdBlocked)
      ) {
        this.compressionQueue.push(chunk.index);
      }
    }

    // ---- 3. Chunk the frontier: compressible messages not owned by any record. ----
    // An audit-only open never mints records: its head window and chunk size
    // are not the resident's, and a record written here would be compressed
    // by the resident at its next boot.
    if (this.config.auditOnly) {
      this.orderCompressionQueue();
      return;
    }
    const messagesToChunk = this.getCompressibleMessages(store, consumed);
    const livePosition = position;

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
      // span is owned and never re-keyed by config drift or restarts. A dry
      // select's chunks stay unrecorded: select() puts the last committing
      // rebuild's chunks back after it.
      if (this.chunkPersistenceEnabled && !this._dryRunSelect) {
        const record: ChunkRecord = {
          id: `c-${this.chunkIdCounter++}`,
          sourceIds: chunk.messages.map(m => m.id),
          compressed: false,
        };
        this.appendChunkRecord(record);
        chunk.recordId = record.id;
      }
      for (const m of chunk.messages) {
        const at = position.get(m.id);
        if (at !== undefined) byPosition[at] = chunk;
      }
      this.chunks.push(chunk);
      this.compressionQueue.push(chunk.index);

      currentChunk = [];
      currentTokens = 0;
      chunkFilteredStart = endExclusive;
    };

    for (let i = 0; i < messagesToChunk.length; i++) {
      const msg = messagesToChunk[i];
      const previous = currentChunk[currentChunk.length - 1];
      if (
        previous &&
        livePosition.get(msg.id) !== (livePosition.get(previous.id) ?? -2) + 1
      ) {
        // The filtered compressible stream can jump over record-owned,
        // pinned, or current-head messages. Joining the two sides minted
        // Fable's disjoint L1-267/L1-403 chunks: one recall then owned two
        // distant chronological regions and poisoned every ancestor merge.
        // Close even a thin run at the ownership seam. A short summary (or
        // raw fallback while it is pending) is cheaper than a non-tree span.
        closeCurrent(i);
      }
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
    this.orderCompressionQueue();
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

  /** True if the content carries an image, nested in a tool_result or not
   *  (see inline-images.ts). */
  protected hasImageBlock(content: ContentBlock[]): boolean {
    return hasImage(content);
  }

  /** Message index marking the image-strip depth boundary: walks newest→oldest
   *  summing each stored message's estimate as the store prices it
   *  (store.estimateTokens, calibrated), before tool pruning and image
   *  strips: the depth rule postStripEstimates and imageStripReplay use too
   *  (the recent window's walk, getUnheldRecentWindowStart, sums them
   *  after both). It returns the index of the first message still within
   *  `depthTokens`. Messages before this index have their images stripped
   *  to placeholders. */
  protected getImageStripStart(store: MessageStoreView, depthTokens: number): number {
    const messages = store.getAll();
    let tokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > depthTokens) return i + 1;
    }
    return 0;
  }

  /** Text substituted for an image block the context doesn't carry. It
   *  names no particular limit and no recency, since several rules write it:
   *  the count, byte and depth limits (the byte rule is greedy, so a large
   *  newest image can be replaced while smaller older ones stay), the
   *  hysteresis rule, which trims to a fraction of them, and the compression
   *  request's own image byte cap. Windowed passthrough uses the same text. */
  private static readonly IMAGE_PLACEHOLDER = '[image not shown: this context keeps only some images]';

  /** Post-pass over compiled entries: replace image blocks with a text
   *  placeholder once they fall outside the live-image window — either deeper
   *  than `imageStripDepthTokens` from the newest message, or beyond the
   *  `maxLiveImages` most-recent images (counted newest-first). Summaries are
   *  already text, so they're naturally unaffected. The adjacent
   *  "[image attachment: <name>]" text added at ingest preserves the filename,
   *  so the placeholder itself stays terse. Reduces tokens, so it never pushes
   *  a compiled context back over budget, apart from an image priced below
   *  the placeholder (see `strippedImageSaving`). With
   *  `imageStripHysteresisRatio`, the rule's set (imageStripReplay) decides
   *  in place of the limits: a message's first images go, as many as the
   *  rule strips of it, applied on every path as `asEstimated` applies them.
   *
   *  Runs INSIDE each select path, *before* `rsEnd()` and `placeCacheMarkers`,
   *  so the cache breakpoints describe the post-strip context. It leaves the
   *  render stats' buckets as each selection tallied them: `selectAdaptive`
   *  at post-strip prices, and `selectHierarchical` at the store's full
   *  estimate of each message as it's sent (prunedForSend), so that its
   *  `RenderStats.total` counts a stripped image at full price. Both add what
   *  a `maxMessageTokens` cut changes (cappedForSend), which leaves a
   *  message's images at the price the selection gave them.
   *
   *  `asEstimated`: the caller prices messages by `postStripEstimates`, so
   *  the strip applies the verdicts that pass gave each image of each stored
   *  message's cut (cappedForSend), rather than counting the images it sends.
   *  An image's verdict is its own message's: the entry's source's, or, for
   *  an image in a tool result that pairing repair moved into this entry,
   *  the message it was moved from, which relocateOrDropMissingResults
   *  records where the entry it moved it from has an id, as every entry that
   *  holds a tool result does. Within the message, a tool result's images, and the top-level
   *  images, take that group's verdicts in order, since the cut and the
   *  repair keep each block's images in order, copying a block at most. A
   *  result the repair drops, such as a second one for a call, leaves its
   *  verdicts unused, so its images took slots the window could have used.
   *  Two results for one call id in a single message share a group, which
   *  pairing repair, taking ids to be unique, doesn't expect: where it moves
   *  one, they can take each other's verdicts. A verdict whose image had
   *  another payload (imagePayload) isn't this image's, so the image is
   *  replaced, as is one with no verdict at all, such as an entry with no
   *  source would send: both err under the budget. Only the same image in
   *  both, stamped at two prices, could go out live at the higher price on
   *  the lower one's verdict.
   *  Each image's verdict then follows from the store alone, whichever
   *  messages the layout folds or the repair moves. `selectAdaptive` asks: every budgeting site in it prices a
   *  message by those estimates, with what a cut changes added, apart from
   *  the middle region's text-only entry of a sharded body, priced by its
   *  text. So does the kv-unified cache check's rebuild of what it sends
   *  (kvUnifiedKeepEntries). `renderAsNewest` needn't: it sends every
   *  message from its first to the newest, so no newer message goes unsent.
   *  `selectHierarchical` doesn't: its emission prices
   *  head, middle and tail at the store's full estimate of each message as
   *  it's sent, with what a cut changes added. So it priced no image as the
   *  placeholder, and counting images it doesn't send would only cost it
   *  live ones. (Its recent window's start and imageStripReplay count each
   *  stored message's images as it's sent, as the estimates do.) A caller that
   *  prices by the estimates asks too. With `imageStripHysteresisRatio`,
   *  every caller gets the verdicts: the rule's set is per stored message,
   *  so counting what the entries send has nothing to add, and a tool result
   *  pairing repair moved keeps its own message's count. */
  protected applyImageStripping(entries: ContextEntry[], store: MessageStoreView, opts: { asEstimated?: boolean } = {}): void {
    const maxLive = this.config.maxLiveImages ?? 0;             // 0 = unlimited count
    const depthTokens = this.config.imageStripDepthTokens ?? 0; // 0 = no depth strip
    const maxLiveBytes = this.config.maxLiveImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES;
    // Policy disabled: no limit is positive, as postStripEstimates decides it,
    // which then gives no verdicts.
    if (!(maxLive > 0) && !(depthTokens > 0) && !(maxLiveBytes > 0)) return;

    const messages = store.getAll();
    const posById = this.positionIndex(messages);
    // Image-bearing entries, newest-first by source position. Entries with no
    // resolvable source position sort last (pos -1).
    const ordered = entries
      .map((entry, idx) => ({
        idx,
        pos: entry.sourceMessageId !== undefined ? posById.get(entry.sourceMessageId) ?? -1 : -1,
      }))
      .filter(({ idx }) => this.hasImageBlock(entries[idx].content))
      .sort((a, b) => b.pos - a.pos);

    if (opts.asEstimated || this.imageHysteresisRatio() !== undefined) {
      const verdicts = this.postStripVerdicts(store);
      const taken = new Map<number, Map<unknown, number>>();
      /** The verdict of the next image of `group` in the message at `home`,
       *  if that image has this image's payload. */
      const verdictOf = (image: ContentBlock, home: number, group: unknown): boolean => {
        let byGroup = taken.get(home);
        if (!byGroup) taken.set(home, byGroup = new Map());
        const n = byGroup.get(group) ?? 0;
        byGroup.set(group, n + 1);
        const judged = verdicts.get(home)?.get(group)?.[n];
        return judged !== undefined && judged.key === imagePayload(image) && judged.keep;
      };
      for (const { idx, pos } of ordered) {
        const keeps: boolean[] = [];
        for (const block of entries[idx].content) {
          const group = imageGroup(block);
          // A tool result's images are its own message's: this entry's, or,
          // where pairing repair moved it here, the one it was moved from.
          const from = this._movedFrom.get(block);
          const home = from === undefined ? pos : posById.get(from) ?? -1;
          for (const image of imagesIn([block])) keeps.push(verdictOf(image, home, group));
        }
        // replaceImages asks about each image once, in imagesIn's order.
        let next = 0;
        entries[idx].content = replaceImages(entries[idx].content, () => !keeps[next++],
          AutobiographicalStrategy.IMAGE_PLACEHOLDER);
      }
      return;
    }

    // Counting what the entries send: an entry with no resolvable position is
    // stripped wherever a depth limit is set. A merged body's images all sit
    // at its first shard's position, in block order: chunkIngressMessage puts
    // every non-text block of a body on its first shard, and
    // mergeAdjacentBodyGroupRaw keeps them ahead of the text, so they are that
    // shard's images. (A chunker that spread images over shards would need a
    // position per image.)
    const stripStart = depthTokens > 0 ? this.getImageStripStart(store, depthTokens) : 0;

    // The region each source position fell in when select() bucketed it. The
    // strip leaves the buckets as each selection tallied them (see the doc above).
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = Math.max(this.getRecentWindowStart(store), headEnd);
    const bucketAt = (pos: number): 'head' | 'tail' | 'middleRaw' => {
      if (pos < 0) return 'middleRaw'; // no resolvable region — keep total == Σbuckets
      if (pos >= headStart && pos < headEnd) return 'head';
      if (pos >= recentStart) return 'tail';
      return 'middleRaw';
    };

    let keptImages = 0;
    let keptImageBytes = 0;
    /** Whether the policy keeps this image, counting it live if so. */
    const keeps = (image: ContentBlock, pos: number): boolean => {
      const tooDeep = depthTokens > 0 && (pos < 0 || pos < stripStart);
      const blockBytes = inlineImageBytes(image);
      const overCount = maxLive > 0 && keptImages >= maxLive;
      const overBytes = maxLiveBytes > 0 && keptImageBytes + blockBytes > maxLiveBytes;
      if (tooDeep || overCount || overBytes) return false;
      keptImages++;
      keptImageBytes += blockBytes;
      return true;
    };
    for (const { idx, pos } of ordered) {
      const entry = entries[idx];
      const bucket = bucketAt(pos);
      // Every image the entry carries, nested in a tool_result included, in
      // the order postStripEstimates and imageStripReplay count them. A block
      // is copied only when an image in it goes, and the raw forms an edited
      // block carried are released, so a replay can't bring the image back.
      entry.content = replaceImages(entry.content, (image) => {
        if (keeps(image, pos)) return false;
        // Stats-neutral: the bucket stays as its path tallied it (see the
        // doc above). selectAdaptive tallies at post-strip prices, so
        // reclaiming here would double-decrement there. The strip pass only
        // swaps the block.
        void bucket;
        return true;
      }, AutobiographicalStrategy.IMAGE_PLACEHOLDER);
    }
  }

  /** Hysteresis ratio in (0, 1), or undefined when the option is off. */
  private imageHysteresisRatio(): number | undefined {
    const r = this.config.imageStripHysteresisRatio;
    return typeof r === 'number' && r > 0 && r < 1 ? r : undefined;
  }

  /**
   * imageStripHysteresisRatio's set, from the stored messages and the limits
   * alone: replay the messages oldest first, admitting each one's images in
   * order, and whenever a limit binds (`maxLiveImages`, `maxLiveImageBytes`,
   * or the oldest live image deeper than `imageStripDepthTokens`), strip the
   * oldest live images one at a time until every limit fits ratio × itself.
   * A target that rounds to 0 is 0, but the newest image stays while it fits
   * the full limits, and so do the other images of its message while only
   * depth is over its target, since stripping them can't lower the depth
   * they're at. Depth is counted as getImageStripStart counts it: an
   * image's own message and every newer one, at the store's estimates.
   * A message's images are those its cut sends (cappedForSend), nested in a
   * tool_result included, in imagesIn's order and at inlineImageBytes'
   * size, as postStripEstimates counts them. Stripping takes the oldest
   * images first, so a message's stripped images are its first ones: the
   * answer is how many, by message id (a message with none stripped is
   * absent). Undefined when the option is off or no limit is set.
   * postStripEstimates gives those images their verdicts, which
   * applyImageStripping applies on every path while the option is on. The adaptive middle's and kv-unified's raw body entries
   * carry their shards' text alone, so the images of those shards aren't
   * sent, though the rule counts them toward the limits, and the budget
   * prices them.
   */
  protected imageStripReplay(store: MessageStoreView): ReadonlyMap<MessageId, number> | undefined {
    const ratio = this.imageHysteresisRatio();
    if (ratio === undefined) return undefined;
    const depthCap = this.config.imageStripDepthTokens ?? 0;
    const countCap = this.config.maxLiveImages ?? 0;
    const bytesCap = this.config.maxLiveImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES;
    if (!(depthCap > 0) && !(countCap > 0) && !(bytesCap > 0)) return undefined;
    return this.withToolPruning(store, () => {
      // Keyed as the post-strip memo is: the store's cached listing, its
      // calibration (depth is counted at calibrated estimates), the knobs,
      // and what decides the cut's images: the tool pruning and the cap.
      const messages = store.getAll();
      const calibration = store.getTokenCalibration?.() ?? 1;
      const pruning = this._toolPruningInUse!.pruning;
      const msgCap = this.config.maxMessageTokens;
      const memo = this._imageStripReplayMemo;
      if (
        memo && memo.messages === messages && memo.calibration === calibration && memo.depthCap === depthCap &&
        memo.countCap === countCap && memo.bytesCap === bytesCap && memo.ratio === ratio &&
        memo.pruning === pruning && memo.msgCap === msgCap
      ) return memo.out;
      // tokensBefore[i]: the tokens of every message before i, so the depth of
      // an image in message j, with message i the newest, is
      // tokensBefore[i + 1] - tokensBefore[j].
      const tokensBefore = new Array<number>(messages.length + 1);
      tokensBefore[0] = 0;
      for (let i = 0; i < messages.length; i++) tokensBefore[i + 1] = tokensBefore[i]! + store.estimateTokens(messages[i]!);
      const live: Array<{ at: number; bytes: number }> = []; // oldest first; live[first..] are live
      let first = 0;
      let liveBytes = 0;
      const out = new Map<MessageId, number>();
      for (let i = 0; i < messages.length; i++) {
        for (const image of imagesIn(this.cappedForSend(store, messages[i]!, msgCap).content)) {
          const bytes = inlineImageBytes(image);
          live.push({ at: i, bytes });
          liveBytes += bytes;
        }
        const overCountOrBytes = (count: number, size: number): boolean =>
          (countCap > 0 && live.length - first > count) || (bytesCap > 0 && liveBytes > size);
        const over = (depth: number, count: number, size: number): boolean =>
          overCountOrBytes(count, size) ||
          (depthCap > 0 && first < live.length && tokensBefore[i + 1]! - tokensBefore[live[first]!.at]! > depth);
        if (!over(depthCap, countCap, bytesCap)) continue;
        const depth = Math.floor(depthCap * ratio);
        const count = Math.floor(countCap * ratio);
        const size = Math.floor(bytesCap * ratio);
        while (first < live.length && over(depth, count, size)) {
          // The images left are one message's and within the full limits: the
          // newest of them stays, and the rest stay too while only depth is over
          // its target, since stripping images of one message can't lower the
          // depth it's at.
          if (
            live[first]!.at === live[live.length - 1]!.at && !over(depthCap, countCap, bytesCap) &&
            (live.length - first === 1 || !overCountOrBytes(count, size))
          ) break;
          const oldest = live[first++]!;
          liveBytes -= oldest.bytes;
          const id = messages[oldest.at]!.id;
          out.set(id, (out.get(id) ?? 0) + 1);
        }
      }
      this._imageStripReplayMemo = { messages, calibration, depthCap, countCap, bytesCap, ratio, pruning, msgCap, out };
      return out;
    });
  }

  private _imageStripReplayMemo: {
    messages: readonly StoredMessage[]; calibration: number; depthCap: number; countCap: number; bytesCap: number; ratio: number;
    pruning: object; msgCap: number | undefined; out: ReadonlyMap<MessageId, number>;
  } | null = null;

  /**
   * Post-strip token estimate per message index (2026-07-12 tail-starvation
   * fix). Mirrors `applyImageStripping` as `selectAdaptive` asks for it
   * (`asEstimated`): an image beyond the `maxLiveImages`
   * newest (counted newest-first) or deeper than `imageStripDepthTokens` of
   * the store's (calibrated) estimate from the live end renders as a placeholder — so every place
   * that BUDGETS messages (recent-window walk-back, head/tail sums, middle
   * chunk sizes) must cost it as one. With `imageStripHysteresisRatio`, the
   * rule's set (imageStripReplay) decides in place of the limits: a
   * message's first images are priced as placeholders, as many as the rule
   * strips of it. Pricing stripped images at their full
   * estimate collapsed an image-dense tail to a fraction of its configured
   * size (42k rendered of a 120k window), and pricing them post-strip in the
   * walk-back alone made the picker's raw-priced tail overflow the budget
   * (318k) — the estimate must be consistent EVERYWHERE.
   * Each message is priced in the form it's sent in (prunedForSend), so a
   * tool result `toolResultMaxLastN` replaces costs its marker and a
   * `tool_use` input `toolUseInputMaxTokens` truncates costs its truncation.
   * Its images are counted in the form its cut sends (cappedForSend), and the
   * verdict each gets is kept for the strip, which applies it
   * (applyImageStripping's asEstimated). A cut that leaves an image out, as an
   * override of `truncateContent` can, takes it off at its full price through
   * the cut's extra, which every site that prices what's sent adds. Two sites
   * don't: the recent window's size (getUnheldRecentWindowStart), since no
   * window's size is measured after the cap (see cappedForSend), and the
   * middle region's text-only entry of a sharded body, which sends its
   * shards uncut. The strip depth is still
   * measured over the stored messages, as getImageStripStart measures it.
   */
  protected postStripEstimates(store: MessageStoreView): number[] {
    return this.withToolPruning(store, () => this.postStripEstimatesHeld(store, this._toolPruningInUse!.pruning));
  }

  /** The verdicts postStripEstimates gave each message's images (see
   *  applyImageStripping's asEstimated). */
  private postStripVerdicts(store: MessageStoreView): NonNullable<AutobiographicalStrategy['_postStripMemo']>['verdicts'] {
    // The pass leaves its memo set for this listing, hit or miss.
    this.withToolPruning(store, () => this.postStripEstimatesHeld(store, this._toolPruningInUse!.pruning));
    return this._postStripMemo!.verdicts;
  }

  private postStripEstimatesHeld(
    store: MessageStoreView,
    pruning: ToolPruningDecision,
  ): number[] {
    const messages = store.getAll();
    const stripDepth = this.config.imageStripDepthTokens ?? 0;
    const maxLive = this.config.maxLiveImages ?? 0;
    const maxLiveBytes = this.config.maxLiveImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES;
    // A compile asks for this pass more than once (recent-window scan, then
    // the picker inputs). The listing array is the store's own cached view,
    // so its identity, calibration and the knobs key the memo, the
    // hysteresis ratio among them: it decides whether imageStripReplay's set
    // strips, and that set reads nothing the key leaves out. A branch reload
    // clears the memo. Callers treat the array as read-only.
    const memoCalibration = store.getTokenCalibration?.() ?? 1;
    const ratio = this.imageHysteresisRatio();
    // The cut decides which images go out, so its cap keys the memo too: a
    // preview can override it alone.
    const msgCap = this.config.maxMessageTokens;
    const memo = this._postStripMemo;
    if (
      memo && memo.messages === messages && memo.calibration === memoCalibration &&
      memo.stripDepth === stripDepth && memo.maxLive === maxLive && memo.maxLiveBytes === maxLiveBytes &&
      memo.ratio === ratio && memo.pruning === pruning && memo.msgCap === msgCap
    ) return memo.out;
    const out = new Array<number>(messages.length);
    // What applyImageStripping's asEstimated applies: by message position,
    // each block's images (a tool result's by its call's id, the top-level
    // images together), each with its payload (imagePayload) and whether the
    // strip keeps it, in order.
    const verdicts = new Map<number, Map<unknown, Array<{ key: unknown; keep: boolean }>>>();
    const stripActive = stripDepth > 0 || maxLive > 0 || maxLiveBytes > 0;
    // With imageStripHysteresisRatio, the rule's set decides in place of the
    // limits, which it already fits: a message's first images, as many as
    // the rule strips of it, in the order the cut sends them.
    const replay = stripActive ? this.imageStripReplay(store) : undefined;
    // The placeholder as the store prices it, calibrated, by its own text
    // estimator: the price of the block that replaces a stripped image.
    const placeholderPrice = store.estimateTokens(
      { content: [{ type: 'text', text: AutobiographicalStrategy.IMAGE_PLACEHOLDER }] } as unknown as StoredMessage,
    );
    // `store.estimateTokens` prices every block at round(raw × calibration);
    // the stripped image's share must come off at that SAME price
    // (strippedImageSaving). Subtracting the uncalibrated 1600 drove
    // image-only messages NEGATIVE whenever the calibration multiplier sat
    // below ~0.995 (0.93 → 1488 − 1591 = −103), which kv-unified's
    // canonical-forest check then rejects on every compile ("chunk N has
    // invalid raw cost -111") — a hard-down that cannot heal, since
    // calibration only moves after a successful call.
    const calibration = store.getTokenCalibration?.() ?? 1;
    let liveImagesSeen = 0;
    let liveImageBytes = 0;
    // Depth from the newest message, this one included, in the store's
    // calibrated estimate, as getImageStripStart sums it: the message that
    // crosses the depth is beyond it, and the strip replaces its images.
    // (`raw` and `rawDepth` are pre-strip, not uncalibrated.)
    let rawDepth = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const raw = store.estimateTokens(messages[i]);
      rawDepth += raw;
      const sent = this.prunedForSend(store, messages[i]!);
      let est = sent === messages[i] ? raw : store.estimateTokens(sent);
      if (stripActive) {
        // The images the cut sends (cappedForSend), whose verdicts the strip
        // applies, so a cut that leaves one out takes it off at its full
        // price, through the cut's extra, rather than here.
        // Block by block, which walks the cut's images in imagesIn's order.
        const cut = this.cappedForSend(store, messages[i]!, msgCap).content;
        const groups = new Map<unknown, Array<{ key: unknown; keep: boolean }>>();
        let ruleLeft = replay !== undefined ? replay.get(messages[i]!.id) ?? 0 : undefined;
        for (const block of cut) {
          const group = imageGroup(block);
          for (const b of imagesIn([block])) {
            const bytes = inlineImageBytes(b);
            const beyondDepth = stripDepth > 0 && rawDepth > stripDepth;
            const beyondCount = maxLive > 0 && liveImagesSeen >= maxLive;
            const beyondBytes = maxLiveBytes > 0 && liveImageBytes + bytes > maxLiveBytes;
            let keep: boolean;
            if (ruleLeft !== undefined) {
              keep = !(ruleLeft > 0);
              if (!keep) ruleLeft--;
            } else {
              keep = !(beyondDepth || beyondCount || beyondBytes);
            }
            if (keep) {
              liveImagesSeen++;
              liveImageBytes += bytes;
            } else {
              est -= strippedImageSaving(b, placeholderPrice, calibration);
            }
            let judged = groups.get(group);
            if (!judged) groups.set(group, judged = []);
            judged.push({ key: imagePayload(b), keep });
          }
        }
        if (groups.size > 0) verdicts.set(i, groups);
      }
      // Belt and braces: a message never costs less than nothing.
      out[i] = Math.max(0, est);
    }
    this._postStripMemo = { messages, calibration: memoCalibration, stripDepth, maxLive, maxLiveBytes, ratio, pruning, msgCap, out, verdicts };
    return out;
  }

  private _postStripMemo: {
    messages: readonly StoredMessage[]; calibration: number; stripDepth: number; maxLive: number; maxLiveBytes: number; ratio: number | undefined; pruning: object; msgCap: number | undefined; out: number[];
    verdicts: ReadonlyMap<number, ReadonlyMap<unknown, ReadonlyArray<{ key: unknown; keep: boolean }>>>;
  } | null = null;

  /** Byte wall default: 20MB of base64 (API total-request cap is 32MB). */
  protected static readonly DEFAULT_MAX_LIVE_IMAGE_BYTES = 20 * 1024 * 1024;

  /** Compression prompts carry head + recall frontier + raw chunk alongside
   *  their images, so they get a tighter image budget than the live window. */
  protected static readonly DEFAULT_MAX_COMPRESSION_IMAGE_BYTES = 12 * 1024 * 1024;

  /**
   * Inline payload characters of an image, as the live limits count them
   * (inlineImageBytes in inline-images.ts): a base64 source, a `data:` URL
   * source, or a `data` field beside `mimeType`; 0 for a remote URL. The
   * strategy itself counts through inline-images.ts; this stays for
   * subclasses, since 0.5.9 shipped it (then it counted base64 sources only).
   */
  protected static imageBlockBytes(b: unknown): number {
    return inlineImageBytes(b);
  }

  /**
   * The same inline size, under the name 0.15.0 shipped for the compression
   * image cap's count: inlineImageBytes in inline-images.ts, which the cap
   * now uses directly. Kept for subclasses.
   */
  protected static compressionImageBytes(b: unknown): number {
    return inlineImageBytes(b);
  }

  /** Requests prepared before they are sent, with what preparing them replaced. */
  private readonly compressionPreparedAhead = new WeakMap<NormalizedRequest, PreparationCounts>();

  /**
   * Prepare a compression request: serialized data URLs become markers, then
   * inline images are capped. The result owns its message wrappers and copies
   * only what it changes, so stored messages and other requests are never
   * edited, and preparing a prepared request changes nothing. It doesn't log.
   */
  protected prepareCompressionRequest(request: NormalizedRequest): CompressionPreparation {
    const prepared = { ...request, messages: request.messages.map(message => ({ ...message })) };
    const serializedMediaReplacements = this.stripSerializedCompressionMedia(prepared.messages);
    const imageBudgetBytes =
      this.config.maxCompressionImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_COMPRESSION_IMAGE_BYTES;
    const cap = { keptBytes: 0 };
    const imageReplacements = this.capCompressionImageBytes(prepared.messages, imageBudgetBytes, cap);
    return {
      request: prepared, serializedMediaReplacements, imageReplacements, imageBudgetBytes, imageBytesKept: cap.keptBytes,
    };
  }

  /**
   * Prepare a request that is hashed and priced before it is sent: the
   * canonical and source-only L1 requests, the recall-curve variants and the
   * tool-prose rewrite. Many are never sent, so what preparation replaced is
   * logged only when one is, by prepareCompressionCandidate.
   */
  private prepareCompressionAhead(request: NormalizedRequest): NormalizedRequest {
    const { request: prepared, ...counts } = this.prepareCompressionRequest(request);
    this.compressionPreparedAhead.set(prepared, counts);
    return prepared;
  }

  /**
   * Prepare a request as it is sent, and log what preparation replaced in it,
   * naming the request. A request prepared ahead is logged here, once.
   */
  private prepareCompressionCandidate(request: NormalizedRequest, label: string): NormalizedRequest {
    const ahead = this.compressionPreparedAhead.get(request);
    if (ahead) {
      this.compressionPreparedAhead.delete(request);
      this.logCompressionPreparation(ahead, label);
      return request;
    }
    const prepared = this.prepareCompressionRequest(request);
    this.logCompressionPreparation(prepared, label);
    return prepared.request;
  }

  /** One line per kind of replacement, naming the request. */
  private logCompressionPreparation(counts: PreparationCounts, label: string): void {
    if (counts.serializedMediaReplacements > 0) {
      this.diag.error(
        `[autobiographical] compression prompt: replaced ${counts.serializedMediaReplacements} ` +
          `serialized data URL(s) with markers [${label}]`,
      );
    }
    if (counts.imageReplacements > 0) {
      const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
      this.diag.error(
        `[autobiographical] compression prompt: replaced ${counts.imageReplacements} image(s) with placeholders ` +
          `to stay under the ${mib(counts.imageBudgetBytes)} inline image budget ` +
          `(kept ${mib(counts.imageBytesKept)}, newest messages first) [${label}]`,
      );
    }
  }

  /** Ignore short data-URL examples while catching actual serialized media. */
  protected static readonly SERIALIZED_DATA_URL_MIN_CHARS = 4096;

  /**
   * Replace large base64 data URLs that a compression prompt carries as text:
   * in text blocks, in tool results (string or block array), and in a tool
   * call's input, its strings or the text of arguments that didn't parse. An imported tool result can carry a
   * foreign harness's image JSON instead of a native image block; the image
   * byte cap can't see those bytes, and they are priced as prose (a 1 MiB
   * image is about 1.4 million base64 characters). It replaces each given
   * message's content array and copies the blocks it changes, so a caller
   * passes message wrappers it owns, as prepareCompressionRequest does, and
   * stored Chronicle messages are never mutated. The marker keeps the
   * payload's length in the text, and the media type when the decoded type
   * reads as one.
   */
  protected stripSerializedCompressionMedia(messages: Array<{ content: ContentBlock[] }>): number {
    const minChars = AutobiographicalStrategy.SERIALIZED_DATA_URL_MIN_CHARS;
    // `+`, not `{minChars,}`: V8's irregexp overflows the stack on a counted
    // quantifier once a MATCHING run reaches ~8M characters (node 22), which
    // is exactly the media size this targets. The length floor is applied
    // below instead.
    // Also matches MIME parameters before `;base64` (`;charset=…`,
    // `;name="a b.png"`) and the JSON escapes serializers emit, however many
    // times the text was serialized: escaped slashes (`image\/png`,
    // `image\\\/png`), `\u` escapes in the type (`image\u002Fsvg\u002Bxml`),
    // and escapes inside the payload, such as `\n` where base64 was wrapped or
    // `\u002F`. Any letter case matches (`DATA:`, `;BASE64,`), as URL schemes
    // and the base64 token do. Bare base64 under a JSON key (Anthropic
    // `"source":{"data":…}`) is out of scope. Every choice in the pattern is
    // decided by the next character (a \u002F escape is only ever the type's
    // slash, and a quoted parameter value holds no backslash or quote), so a
    // string that almost matches fails in linear time: overlapping choices
    // took time exponential in its number of parameters.
    // Everything before the payload is bounded. The type's two names and
    // each parameter name take at most 127 characters, as RFC 6838 bounds
    // them. There are at most 16 parameters, with values of at most 1,024
    // characters: RFC 6838 sets no such bounds, so these two are this
    // matcher's own. A `\u` escape counts as one character, however many
    // backslashes it carries. A data URL past a bound isn't matched, and its
    // payload stays. An unbounded run overflowed V8's stack at about 8.45M
    // characters of a string that almost matches (`data:` and a run with no
    // slash, or one long parameter value), which the floor above couldn't
    // help, since nothing matched.
    const dataUrl =
      /data:((?:[A-Za-z0-9]|\\+u(?!002f)[0-9a-f]{4})(?:[A-Za-z0-9!#$&^_.+-]|\\+u(?!002f)[0-9a-f]{4}){0,126}(?:\\*\/|\\+u002f)(?:[A-Za-z0-9]|\\+u(?!002f)[0-9a-f]{4})(?:[A-Za-z0-9!#$&^_.+-]|\\+u(?!002f)[0-9a-f]{4}){0,126})(?:;[A-Za-z0-9!#$&^_.+-]{1,127}=(?:\\*"(?:[^"\\]|\\+u[0-9a-f]{4}){0,1024}\\*"|(?:[^;,:\s"\\]|\\+u[0-9a-f]{4}){0,1024})){0,16};base64,([A-Za-z0-9+/_=\\-]+)/gi;
    let replaced = 0;
    // Every backslash run in a matched type ends in `u` and four hex digits
    // or in its slash, so one pass reads each run once.
    const unescapeType = (type: string) => type.replace(
      /\\+(?:u([0-9a-f]{4})|\/)/gi, (_, hex?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : '/'),
    );
    // A `\u` escape can spell any character into a matched type, so the
    // marker names the type only once it reads as a media type.
    const mediaTypeName = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
    // A data URL's head, matched in place, to tell a run that reaches the
    // next data URL from one that runs into a word ending in `data`.
    const dataUrlAt = new RegExp(dataUrl.source, 'iy');
    const base64Char = /[A-Za-z0-9+/=_-]/;
    const stripText = (text: string): string => {
      // What the run of backslashes at `i` escapes: one base64 character,
      // which is payload (`\/`, `\u002B`), a line break (`\n`, `\r\n`, `\r`
      // and their `\u000a` and `\u000d` forms), or something else. A
      // `\r\n` pair is one break when both halves carry the same run.
      const escapeAt = (i: number): { kind: 'char' | 'break' | 'other'; next: number } => {
        let j = i;
        while (text[j] === '\\') j++;
        const slashes = text.slice(i, j);
        const c = text[j];
        if (c === '/') return { kind: 'char', next: j + 1 };
        if (c === 'n') return { kind: 'break', next: j + 1 };
        if (c === 'r') {
          return text.startsWith(slashes + 'n', j + 1)
            ? { kind: 'break', next: j + 1 + slashes.length + 1 }
            : { kind: 'break', next: j + 1 };
        }
        if ((c === 'u' || c === 'U') && /^[0-9a-f]{4}$/i.test(text.slice(j + 1, j + 5))) {
          const code = parseInt(text.slice(j + 1, j + 5), 16);
          if (base64Char.test(String.fromCharCode(code))) return { kind: 'char', next: j + 5 };
          if (code === 0x0a) return { kind: 'break', next: j + 5 };
          if (code === 0x0d) {
            const pair = text.slice(j + 5, j + 5 + slashes.length + 5);
            return pair.length === slashes.length + 5 && pair.startsWith(slashes) && /^u000a$/i.test(pair.slice(slashes.length))
              ? { kind: 'break', next: j + 5 + slashes.length + 5 }
              : { kind: 'break', next: j + 5 };
          }
        }
        return { kind: 'other', next: j };
      };
      let out = '';
      let copied = 0;
      dataUrl.lastIndex = 0;
      for (let m = dataUrl.exec(text); m; m = dataUrl.exec(text)) {
        const [match, mediaType, run] = m;
        const payloadStart = m.index + match.length - run.length;
        let runEnd = m.index + match.length;
        // A run that reaches the next data URL (`…AAAAdata:`, or `…\ndata:`
        // in JSON) ends before it. The scan resumes where the payload ends.
        if (text[runEnd] === ':' && run.slice(-4).toLowerCase() === 'data') {
          dataUrlAt.lastIndex = runEnd - 4;
          if (dataUrlAt.test(text)) runEnd -= 4;
        }
        // The payload is the run's base64 characters, an escaped one
        // counting as one toward its line. An escaped line break continues it
        // only after a full wrap line, 60 characters (Ruby's `pack('m')`), 64
        // (PEM) or 76 (MIME), since a wrapped payload's last line is its short
        // one; after any other line, and at any other escape, the payload
        // ends. A raw line break isn't in the run, so it always ends the
        // payload. So the text after a payload's escape stays
        // (`…AAAA\nsome/path rest`), and a backslash that escapes the
        // character after the run (`\"`) does too. A payload whose last line
        // is 60, 64 or 76 characters long can't be told from one that goes on,
        // so it takes the base64 characters after its break with it
        // (`…\nword rest` loses `word`). A payload wrapped at any other width
        // ends at its first break: with that first line under the floor it
        // stays whole, and past the floor only that line is replaced. Its
        // length, for the floor and the marker, is the characters it takes in
        // the text, escapes and breaks included. One pass reads the run.
        let payloadEnd = payloadStart;
        let line = 0;
        for (let i = payloadStart; i < runEnd;) {
          if (text[i] !== '\\') {
            i++;
            line++;
            payloadEnd = i;
            continue;
          }
          const escape = escapeAt(i);
          if (escape.next > runEnd) break;
          if (escape.kind === 'char') {
            i = escape.next;
            line++;
            payloadEnd = i;
          } else if (escape.kind === 'break' && (line === 60 || line === 64 || line === 76)) {
            i = escape.next;
            line = 0;
          } else {
            break;
          }
        }
        const length = payloadEnd - payloadStart;
        if (length >= minChars) {
          const type = unescapeType(mediaType);
          out += text.slice(copied, m.index) +
            `[embedded ${mediaTypeName.test(type) ? `${type} ` : ''}data URL omitted from compression prompt: ` +
            `${length} serialized payload characters]`;
          copied = payloadEnd;
          replaced++;
        }
        dataUrl.lastIndex = payloadEnd;
      }
      return copied === 0 ? text : out + text.slice(copied);
    };
    // A tool call's input is any JSON value; only its strings can carry a
    // data URL. The same value comes back when nothing in it changed.
    const stripJson = (value: unknown): unknown => {
      if (typeof value === 'string') return stripText(value);
      if (Array.isArray(value)) {
        let changed = false;
        const items = value.map((item) => {
          const next = stripJson(item);
          if (next !== item) changed = true;
          return next;
        });
        return changed ? items : value;
      }
      if (value !== null && typeof value === 'object') {
        let changed = false;
        const fields = Object.entries(value).map(([key, item]) => {
          const next = stripJson(item);
          if (next !== item) changed = true;
          return [key, next] as const;
        });
        // fromEntries defines each key as the object's own, as JSON.parse
        // does, so a `__proto__` member stays a member.
        return changed ? Object.fromEntries(fields) : value;
      }
      return value;
    };
    const strip = (blocks: ContentBlock[]): ContentBlock[] => {
      let changed = false;
      const stripped = blocks.map((block) => {
        let next = block;
        if (block.type === 'text') {
          const text = stripText(block.text);
          if (text !== block.text) next = { ...block, text } as ContentBlock;
        } else if (block.type === 'tool_result') {
          const nested = block.content;
          if (typeof nested === 'string') {
            const text = stripText(nested);
            if (text !== nested) next = { ...block, content: text } as ContentBlock;
          } else if (Array.isArray(nested)) {
            const inner = strip(nested);
            if (inner !== nested) next = { ...block, content: inner } as ContentBlock;
          }
        } else if (block.type === 'tool_use') {
          const input = (block as { input?: unknown }).input;
          const strippedInput = stripJson(input);
          if (strippedInput !== input) next = { ...block, input: strippedInput } as ContentBlock;
          // Arguments that didn't parse are kept as their text.
          const unparsed = (block as { unparseableInput?: unknown }).unparseableInput;
          if (typeof unparsed === 'string') {
            const strippedUnparsed = stripText(unparsed);
            if (strippedUnparsed !== unparsed) next = { ...next, unparseableInput: strippedUnparsed } as ContentBlock;
          }
        }
        if (next !== block) changed = true;
        return next;
      });
      return changed ? releaseEditedRawForms(blocks, stripped) : blocks;
    };
    for (const message of messages) message.content = strip(message.content);
    return replaced;
  }

  /**
   * Cap inline image bytes in a COMPRESSION prompt (2026-07-12). The main
   * window enforces `maxLiveImageBytes` through the strip policy; the
   * summarizer's raw-chunk replay had no such wall and leaned on membrane's
   * byte shed instead — which is a transport backstop, not a policy owner
   * (it fired at 27MB on a live merge). Every inline image counts, whatever
   * its shape (see inlineImageBytes), generated images included.
   * Messages are walked newest-first, and the blocks within a message in
   * order; each image is kept if it fits in what's left of the budget, and
   * the others become the same loud placeholder the window uses, so the
   * summarizer is told plainly that it is not seeing them.
   * Returns the number of images replaced; `stats`, when given, receives the
   * bytes kept.
   */
  protected capCompressionImageBytes(
    messages: Array<{ content: ContentBlock[] }>,
    capBytes: number,
    stats?: { keptBytes: number },
  ): number {
    if (capBytes <= 0) return 0;
    let kept = 0;
    let dropped = 0;
    // Images nested in tool_result content count too: an agent that drives a
    // shell/plotter/browser carries most of its image bytes NESTED in tool
    // results, not as top-level blocks. Capping only the top level left those
    // untouched and membrane's transport shed kept firing at 27MB
    // (2026-07-12). The live window's strip walks images the same way (see
    // inline-images.ts).
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!Array.isArray(m.content)) continue;
      m.content = replaceImages(m.content, (image) => {
        const bytes = inlineImageBytes(image);
        if (kept + bytes <= capBytes) {
          kept += bytes;
          return false;
        }
        dropped++;
        return true;
      }, AutobiographicalStrategy.IMAGE_PLACEHOLDER);
    }
    if (stats) stats.keptBytes = kept;
    return dropped;
  }

  protected getRecentWindowStart(store: MessageStoreView): number {
    return this.clampRecentStartToHolds(store, this.getUnheldRecentWindowStart(store));
  }

  /**
   * Compression holds (ContextManager.holdCompression): the earliest held
   * message starts the protected recent window, so neither it, anything after
   * it, nor the tool_use it answers can enter a compressible chunk. With no
   * holds (or a view without the predicate) this returns `start` unchanged.
   */
  protected clampRecentStartToHolds(store: MessageStoreView, start: number): number {
    return Math.min(start, this.holdBoundary(store));
  }

  /** Timeline scans performed by holdBoundary (test instrumentation). */
  protected holdBoundaryScans = 0;

  /**
   * Index where the hold region begins: the earliest held message, stepped
   * back onto the tool_use a held tool_result answers. `store.length()` when
   * nothing is held — and then without scanning the timeline.
   */
  protected holdBoundary(store: MessageStoreView): number {
    const isHeld = store.isCompressionHeld;
    if (!isHeld || (store.hasCompressionHolds && !store.hasCompressionHolds())) {
      return store.length();
    }
    this.holdBoundaryScans++;
    const messages = store.getAll();
    for (let i = 0; i < messages.length; i++) {
      if (isHeld.call(store, messages[i].id)) {
        let b = i;
        if (b > 0 && this.hasToolResult(messages[b])) {
          b--;
          // Adaptive-resolution ingress puts a sharded message's tool_use on
          // its FIRST shard: step back to the start of that body (not over an
          // earlier ingestion of the same text, which shares the group id).
          b = bodyStart((k) => messages[k], b);
        }
        return b;
      }
    }
    return messages.length;
  }

  /**
   * Ids at or after the hold boundary (null when nothing is held). Compute
   * once per pass and test chunks against it with chunkHasHeldMessage.
   */
  protected holdBlockedIds(store: MessageStoreView): Set<string> | null {
    const boundary = this.holdBoundary(store);
    if (boundary >= store.length()) return null;
    const messages = store.getAll();
    const blocked = new Set<string>();
    for (let i = boundary; i < messages.length; i++) blocked.add(messages[i].id);
    return blocked;
  }

  /**
   * Whether any merge source's span reaches the hold boundary. A caller that
   * has read holdBlockedIds for this pass already gives it as `blocked`
   * (null when nothing is held), so a pass over many merges reads the
   * boundary once.
   */
  protected mergeBlockedByHold(
    sourceIds: string[],
    store: MessageStoreView,
    blocked: Set<string> | null = this.holdBlockedIds(store),
  ): boolean {
    if (!blocked) return false;
    return sourceIds.some((id) => {
      const s = this.summaries.find((x) => x.id === id);
      return s !== undefined && (blocked.has(s.sourceRange.last) || blocked.has(s.sourceRange.first));
    });
  }

  /**
   * Compression holds were released: re-queue the chunks they deferred and,
   * when auto-tick is on, resume the background drain.
   */
  onCompressionHoldsReleased(ctx: StrategyContext): void {
    this.requireLoadedBranch('onCompressionHoldsReleased');
    this.rebuildChunks(ctx.messageStore);
    if (this.config.autoTickOnNewMessage && !this.pendingCompression) {
      this.driveSpeculativeDrain(ctx);
    }
  }

  /**
   * Whether a chunk reaches the hold boundary: any of its messages is held,
   * follows a held message, or is the tool_use a held tool_result answers.
   * Only reachable for chunks that closed before the hold was placed; the
   * compression request would otherwise carry the provisional content (as
   * the chunk itself or as its lead-in context).
   */
  protected chunkHasHeldMessage(chunk: Chunk, blocked: Set<string> | null): boolean {
    if (!blocked) return false;
    return chunk.messages.some((m) => blocked.has(m.id));
  }

  protected getUnheldRecentWindowStart(store: MessageStoreView): number {
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
   * Where history starts in the store: the position of the first of `ids`
   * still there (store order), or -1 when none is. A host can remove stored
   * messages (agent-framework's Discord module does, on a delete or a history
   * sync) while a summary over them, or a queued chunk holding them, lives
   * on; -1 means nothing in the store says when that history happened.
   */
  protected startInStore(ids: Iterable<MessageId>, position: ReadonlyMap<MessageId, number>): number {
    let start = -1;
    for (const id of ids) {
      const at = position.get(id);
      if (at !== undefined && (start < 0 || at < start)) start = at;
    }
    return start;
  }

  /**
   * Where a summary starts in the store: its first leaf message still there
   * (expandSummaryToLeafMessageIds, startInStore), whether or not that is
   * sourceRange.first; -1 when none is. The one rule for both recall sets, a
   * compression request's and a merge's (1a), and for where a recall pair
   * sits among them: a summary starting before the history being summarized
   * is recalled, at its start. A summary with no message left isn't: its
   * place is unknown, and its coverage holds no message out of the request.
   */
  protected summaryStartInStore(
    summary: SummaryEntry,
    position: ReadonlyMap<MessageId, number>,
    summariesById: ReadonlyMap<string, SummaryEntry>,
  ): number {
    const leaves = new Set<MessageId>();
    this.expandSummaryToLeafMessageIds(summary, summariesById, leaves);
    return this.startInStore(leaves, position);
  }

  /**
   * The head window a compression or merge request gives as context for the
   * history it summarizes from `pos` on: the head in force when the message at
   * `pos` was the newest, cut at `pos` and at the compression holds
   * (holdBoundary). From the live head's start on, that is the live head,
   * cut at `pos`, so a chunk inside the live head window (one a widened
   * window grew over) no longer gets the head's messages after its start.
   * A `pos` that's unknown (-1: none of the history's messages is left in
   * the store, startInStore) gets no head: nothing in the store says when
   * that history happened, and the live head may have come after it. Before
   * the live head's start, it is the head starting at the latest topic
   * transition message at or before `pos` (isTopicTransitionMessage, the test
   * that restores the live head's start at a restart), or at the opening when
   * there is none, ending by the walk the live head takes from its start
   * (headWindowEndFrom). So history from before a head-window reset gets the
   * head it followed: the opening, or the transition and opening of the topic
   * it was in. There, a chunk that starts at a transition, or at the
   * store's first message (the opening's own chunk, which a reset releases),
   * gets none: nothing came before it.
   *
   * After a reset, these requests gave the new topic's opening ahead of the
   * older history they summarize (#317), where section 1 of
   * compressChunkHierarchical places the chronicle's opening "exactly where
   * the original instance saw it" and keeps later events out.
   *
   * Three things it is, by choice:
   * - Before the live head's start, where a head starts comes from the store
   *   alone, as a restart reads it. A strategy-level resetHeadWindow to a
   *   message that isn't a transition isn't in the store: history before that
   *   message gets the latest transition before it, or the opening, as after a
   *   restart. History from that message on gets the live head, which a
   *   restart moves to the last transition in the store. So a restart gives
   *   the same heads while the live head starts at the last transition in the
   *   store.
   * - A past head is priced with today's headWindowTokens and calibration, as
   *   the live head is, and the ratchet guard (anchorHeadToCoverage) extends
   *   it by today's chunk ownership, not by those in force when it was the
   *   head.
   * - Before the live head's start, any Context Manager message whose text
   *   starts with "[Topic Transition]" starts a head, as the restart reads
   *   one, whether or not resetHeadWindow wrote it.
   */
  protected headAsOf(store: MessageStoreView, pos: number): { start: number; end: number } {
    return this.headsAsOf(store)(pos);
  }

  /**
   * headAsOf for many positions in one store state, such as each queued chunk
   * a count of queued work reads (requestCarriesToolBlocks): the live head's
   * start, the holds and the live head's end are read once, the transitions
   * before the live head's start once when a position before it is asked
   * for, and each past head's end once per start. Tick's requests (through
   * headAsOf) and the count both read heads here, so a subclass that changes
   * heads overrides this.
   */
  protected headsAsOf(store: MessageStoreView): (pos: number) => { start: number; end: number } {
    const liveStart = this.getHeadWindowStartIndex(store);
    const hold = this.holdBoundary(store);
    let liveEnd: number | undefined;
    let messages: StoredMessage[] | undefined;
    let transitions: number[] | undefined;
    const pastEnds = new Map<number, number>();
    return (pos) => {
      if (pos < 0) return { start: liveStart, end: liveStart };
      if (pos >= liveStart) {
        liveEnd ??= this.getHeadWindowEnd(store);
        return { start: liveStart, end: Math.min(liveEnd, hold, pos) };
      }
      messages ??= store.getAll();
      if (!transitions) {
        const found: number[] = [];
        for (let i = 1; i < liveStart && i < messages.length; i++) {
          if (this.isTopicTransitionMessage(messages[i])) found.push(i);
        }
        transitions = found;
      }
      // The latest transition at or before pos, or the opening.
      let start = 0;
      for (let lo = 0, hi = transitions.length - 1; lo <= hi;) {
        const mid = (lo + hi) >> 1;
        if (transitions[mid]! <= pos) {
          start = transitions[mid]!;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      let end = pastEnds.get(start);
      if (end === undefined) {
        end = this.headWindowEndFrom(store, messages, start);
        pastEnds.set(start, end);
      }
      return { start, end: Math.min(end, hold, pos) };
    };
  }

  /**
   * Index of the first message AFTER the head window.
   * Messages [headStart, headEnd) are sent raw, never summarized.
   *
   * The token-derived boundary is priced with the live calibration multiplier,
   * so it moves whenever calibration does. Moving it DOWN used to be a ratchet:
   * the message that fell out of the head was not covered by any chunk, so it
   * became compressible middle, got its own tiny chunk + L1, and from then on
   * was owned, so the head could never grow back over it. Repeated per
   * calibration rise, this peels the head one message at a time into
   * one-message L1s that sit at the start of the chronicle but are created
   * late, so they merge with whatever frontier is open (merge adjacency follows
   * chunk-record order), yielding L2/L3s that mix the opening with weeks-later
   * material (issue #122). See anchorHeadToCoverage.
   */
  protected getHeadWindowEnd(store: MessageStoreView): number {
    return this.headWindowEndFrom(store, store.getAll(), this.getHeadWindowStartIndex(store));
  }

  /**
   * Where a head window starting at `startIdx` ends, by the walk the live head
   * window takes (getHeadWindowEnd): the live head's start, or a past head's
   * (headAsOf).
   */
  protected headWindowEndFrom(store: MessageStoreView, messages: StoredMessage[], startIdx: number): number {
    if (this.config.headWindowTokens <= 0) return 0;
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
        return this.anchorHeadToCoverage(store, messages, boundary, tokens);
      }
    }

    return messages.length;
  }

  /**
   * Head-boundary ratchet guard. When the token boundary lands on an UNOWNED
   * message and chunk coverage resumes later, the messages in between are the
   * head's own tail that a calibration rise pushed out. They were never
   * chunked, and chunking them now would mint out-of-order L1s. Keep them in
   * the head: extend the boundary to the first owned message after it.
   *
   * Only this direction is touched. A boundary already on an owned message,
   * a store with no coverage after the boundary (fresh session, or the
   * uncovered run is the live frontier), and a head that grew over owned
   * messages ("ownership wins", issue #42) all keep the stock boundary. The
   * extension is bounded: the head is a hard reservation in selectAdaptive,
   * so if reaching coverage would take more than 2× headWindowTokens, the
   * gap is not the head's tail and the stock boundary stands.
   */
  private anchorHeadToCoverage(
    store: MessageStoreView,
    messages: StoredMessage[],
    boundary: number,
    tokensThroughBoundary: number,
  ): number {
    if (boundary >= messages.length) return boundary;
    const owned = this.ownedMessageIds();
    if (owned.size === 0 || owned.has(messages[boundary].id)) return boundary;
    const cap = 2 * this.config.headWindowTokens;
    let tokens = tokensThroughBoundary;
    for (let j = boundary + 1; j < messages.length; j++) {
      if (owned.has(messages[j].id)) return j;
      tokens += store.estimateTokens(messages[j]);
      if (tokens > cap) return boundary;
    }
    return boundary;
  }

  /** Ids of every message a chunk record or live L1 owns (L1 `sourceIds` is the
   *  coverage authority when a chunk record has no summary pointer — see the
   *  fold-path fallback in selectAdaptive). Rebuilt when either list changes. */
  private _ownedIdsCache: { key: string; ids: Set<MessageId> } | null = null;
  private ownedMessageIds(): Set<MessageId> {
    const lastChunk = this.chunks[this.chunks.length - 1];
    const key = `${this.chunks.length}:${lastChunk?.messages.length ?? 0}:${this.summaries.length}`;
    if (this._ownedIdsCache?.key === key) return this._ownedIdsCache.ids;
    const ids = new Set<MessageId>();
    for (const ch of this.chunks) for (const m of ch.messages) ids.add(m.id);
    for (const s of this.summaries) if (s.level === 1) for (const id of s.sourceIds) ids.add(id);
    this._ownedIdsCache = { key, ids };
    return ids;
  }

  protected hasToolUse(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_use');
  }

  protected hasToolResult(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_result');
  }

  /**
   * Shared structural pass for both selectors: repair tool pairing over the
   * entries as selected. What sending does to a raw message's tool blocks
   * (toolPruning) was already applied as each was emitted (cappedForSend),
   * since it's decided from the whole conversation, not from the selection.
   */
  private postProcessToolEntries(entries: ContextEntry[]): void {
    this.trimOrphanedToolUse(entries);
    this.enforceToolPairing(entries);
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

  /** Placeholder body for a stub tool_result inserted by enforceToolPairing:
   *  the call's result isn't in the rendered context next to it (see the
   *  cases listed there, and its tail pass, for a last entry that holds both
   *  a call and a result), so the text names no cause. A read-only call can be
   *  made again, and returns what the tool reads now; one with effects
   *  shouldn't be repeated blind. */
  private static readonly STUB_TOOL_RESULT_TEXT =
    '[this call\'s result isn\'t shown in this context. If you need its output and the tool only reads, call it again; you\'ll get what it returns now.]';

  // Track generated objects, not their text: genuine tool output can quote
  // the same marker. Weak keys avoid retaining previous rendered contexts.
  private readonly generatedToolResultStubs = new WeakSet<ContentBlock>();

  private createToolResultStub(toolUseId: string): ContentBlock {
    const stub: ContentBlock = {
      type: 'tool_result',
      toolUseId,
      content: AutobiographicalStrategy.STUB_TOOL_RESULT_TEXT,
    };
    this.generatedToolResultStubs.add(stub);
    return stub;
  }

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
            ? releaseEditedRawForms(entry.content, filtered)
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

    // Tail: an entry containing both tool_use and tool_result can survive
    // trimOrphanedToolUse, which only pops entries with uses but no results.
    if (prevUseIds.size > 0) {
      entries.push({
        index: entries.length,
        participant: 'user',
        sourceRelation: 'derived',
        content: [...prevUseIds].map(id => this.createToolResultStub(id)),
      });
    }

    // Reindex after any splices/appends.
    for (let i = 0; i < entries.length; i++) entries[i].index = i;
  }

  /** The message each tool result pairing repair moved was moved from, by
   *  the block it placed (relocateOrDropMissingResults), where the entry it
   *  came from has an id. */
  private readonly _movedFrom = new WeakMap<ContentBlock, MessageId>();

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
        const source = src.content;
        const real = source[bi];
        const rest = source.filter((_, k) => k !== bi);
        // A raw replay form shared with the results left behind (one
        // <function_results> holding several) is true of neither side once
        // they're apart; each gives it up (see raw-forms.ts).
        src.content = rest.length > 0
          ? releaseEditedRawForms(source, rest)
          : [{ type: 'text', text: '[tool result moved during context repair]' }];
        // The result still reaches the request, next to its tool_use:
        // provenance credits the source body with it there.
        (src.relocatedResults ??= []).push(id);
        const moved = releaseSharedRawFormsOnMove(real, source);
        // Where it came from, for the image strip (applyImageStripping's
        // asEstimated).
        if (src.sourceMessageId !== undefined) this._movedFrom.set(moved, src.sourceMessageId);
        return moved;
      }
      return this.createToolResultStub(id);
    });
  }

  /**
   * What sending a raw message does to its tool blocks, decided from the
   * whole conversation before any selection, so that the plan,
   * the render and the render stats price and send one form:
   *  - `replaced`: each `tool_result` that `toolResultMaxLastN` replaces, by
   *    its message's id and its place in that message's content, with the
   *    marker its content becomes. The count is of calls. A result answers
   *    the earliest call with its id, in an earlier message, that no result
   *    has answered yet, the order pairing repair's look-ahead pairs them in
   *    where it reaches: a result beyond its reach still answers its call and
   *    keeps the slot, as a folded one does. A result with no such call goes
   *    with the call its id last answered, as a further result, and takes no
   *    slot. A result with neither, before any call with its id or beside
   *    only its own message's call, answers none and is left as it is:
   *    pairing repair drops it. Each
   *    tool's answered calls are ordered by their call's message, and calls
   *    made in one message by where the results that answer them are
   *    stored, the order the render sends a batch the repair leaves alone.
   *    All but the last N have every result replaced, whether they render
   *    raw, folded or not at all: no selection brings a replaced result
   *    back. Where the repair moves a batch's results (part of a batch
   *    whose results are split across messages, or all of one when a recall
   *    pair or pin comes between the calls and their results), it sends the
   *    moved results first, in call order, so the render's order can differ,
   *    while still sending at most N whole.
   *  - `inputCap`: `toolUseInputMaxTokens`. A `tool_use` input over it is
   *    truncated by its own size alone (see prunedForSend).
   * Memoized per listing and per the two settings, a map of limits by its
   * content, since it can change in place. The store's listing is a new array
   * after each write, so a compile computes this once. A merged view lists
   * afresh at every read (mergeMessageStoreViews), so whatever prices every
   * raw message holds the decision while it does (withToolPruning). Calls
   * are matched by id, which pairing repair takes to be unique: where a host
   * reuses an id, the repair can pair a result, or a further one, with a
   * different call with that id than this count does, and so send more than
   * N whole. A decision isn't changed once returned, by this method or an
   * override: a different decision is a new object, which is what the
   * prices kept per decision (postStripEstimates) rely on.
   */
  protected toolPruning(store: MessageStoreView): {
    readonly replaced: ReadonlyMap<MessageId, ReadonlyMap<number, string>>;
    readonly inputCap: number;
  } {
    const messages = store.getAll();
    const limits = this.config.toolResultMaxLastN;
    const inputCap = this.config.toolUseInputMaxTokens ?? 0;
    // A limit that is neither a number nor a map of them, such as a caller's
    // explicit null, sets no limit.
    const limited = typeof limits === 'number' || (typeof limits === 'object' && limits !== null);
    const limitsKey = typeof limits === 'object' && limits !== null ? JSON.stringify(limits) : limits;
    const memo = this._toolPruningMemo;
    if (memo && memo.messages === messages && memo.limitsKey === limitsKey && memo.inputCap === inputCap) return memo.pruning;
    const replaced = new Map<MessageId, Map<number, string>>();
    if (limited) {
      for (const [toolName, answered] of answeredToolCalls(messages)) {
        const limit = typeof limits === 'number' ? limits : (limits as Record<string, number | null | undefined>)[toolName];
        if (typeof limit !== 'number' || !(limit >= 0)) continue;
        // A fractional limit keeps its whole part and names itself in the
        // marker, as it always has.
        const keep = Math.floor(limit);
        if (answered.length <= keep) continue;
        answered.sort((a, b) => a.message - b.message || a.place - b.place);
        const marker = AutobiographicalStrategy.toolResultMarker(toolName, limit);
        for (const call of answered.slice(0, answered.length - keep)) {
          for (const result of call.results) {
            let inMessage = replaced.get(result.message);
            if (!inMessage) replaced.set(result.message, (inMessage = new Map()));
            inMessage.set(result.index, marker);
          }
        }
      }
    }
    const pruning = { replaced, inputCap };
    this._toolPruningMemo = { messages, limitsKey, inputCap, pruning };
    return pruning;
  }

  private _toolPruningMemo: {
    messages: readonly StoredMessage[];
    limitsKey: unknown;
    inputCap: number;
    pruning: ToolPruningDecision;
  } | null = null;

  /** The marker a replaced result's content becomes. The whole result is
   *  replaced, not cut short. It names the limit rather than counting what
   *  follows: later results may be replaced too, and with a limit of 0
   *  every one is. Every result the context shows is among the tool's last
   *  N, so "shows only" holds whichever of them are folded. */
  private static toolResultMarker(toolName: string, limit: number): string {
    return limit === 0
      ? `[result of tool '${toolName}' left out: this context shows none of its results]`
      : `[result of tool '${toolName}' left out: this context shows only the tool's last ${limit === 1 ? 'result' : `${limit} results`}]`;
  }

  /**
   * `msg` as this strategy sends it before any cut: each `tool_result`
   * toolPruning replaces carries its marker, and each `tool_use` input over
   * `toolUseInputMaxTokens` becomes `{ _truncated, _originalTokens, _keys }`
   * (its first five keys as stored, which the store sorts). `msg` itself when
   * neither touches it. A compile
   * prices and emits every raw message from this form: postStripEstimates,
   * cappedForSend, the hierarchical selection's raw prices, the adaptive
   * middle's shard path, which sends a shard's text. A raw replay form an edit changes is released
   * (see raw-forms.ts). The store's own message is never written: chunking
   * and compression read it. Each message's form is kept with the
   * replacements and input cap it was made for, so a later decision that
   * leaves the message as it was gives the same form, with its estimates
   * cached as the message's own are, for as long as the store keeps the
   * message's object (across an append; an edit or a branch switch gives
   * every message a new one). An override must likewise give one
   * form for one message and decision: postStripEstimates keeps its prices
   * per listing and decision.
   */
  protected prunedForSend(store: MessageStoreView, msg: StoredMessage): StoredMessage {
    const pruning = this._toolPruningInUse?.store === store ? this._toolPruningInUse.pruning : this.toolPruning(store);
    const results = pruning.replaced.get(msg.id);
    if (!results && !(pruning.inputCap > 0)) return msg;
    const kept = this._prunedForSend.get(msg);
    if (kept && kept.inputCap === pruning.inputCap && sameMarkers(kept.results, results)) return kept.sent;
    let content: ContentBlock[] | null = null;
    let inputs = false;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i]!;
      let next: ContentBlock = block;
      if (block.type === 'tool_use' && pruning.inputCap > 0) {
        inputs = true;
        next = truncatedToolUse(block, pruning.inputCap) ?? block;
      } else if (block.type === 'tool_result') {
        const marker = results?.get(i);
        if (marker !== undefined) next = { ...block, content: marker };
      }
      if (next !== block) (content ??= msg.content.slice())[i] = next;
    }
    const sent = content ? { ...msg, content: releaseEditedRawForms(msg.content, content) } : msg;
    // A message with no tool call to measure and nothing replaced costs a
    // scan, so only the others are kept.
    if (content || inputs) this._prunedForSend.set(msg, { inputCap: pruning.inputCap, results, sent });
    return sent;
  }

  private readonly _prunedForSend = new WeakMap<
    StoredMessage,
    { inputCap: number; results: ReadonlyMap<number, string> | undefined; sent: StoredMessage }
  >();

  /** Hold `store`'s decision while `fn` prices it. A selection and
   *  postStripEstimates price every raw message, and a merged view lists
   *  afresh at every read (mergeMessageStoreViews), so prunedForSend reads
   *  the decision held here rather than the view. Nothing holds it outside
   *  those, so a view read later decides from its listing then. */
  private withToolPruning<T>(store: MessageStoreView, fn: () => T): T {
    if (this._toolPruningInUse?.store === store) return fn();
    const held = this._toolPruningInUse;
    this._toolPruningInUse = { store, pruning: this.toolPruning(store) };
    try {
      return fn();
    } finally {
      this._toolPruningInUse = held;
    }
  }

  private _toolPruningInUse: {
    store: MessageStoreView;
    pruning: ToolPruningDecision;
  } | null = null;

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
        } else if (isImageBlock(block)) {
          lines.push(`[Image]`);
        }
      }
      lines.push('');
    }

    lines.push('</earlier_in_conversation>');
    return lines.join('\n');
  }

  /**
   * Put the Context Manager's resume turn (RECALL_RESUME_TEXT) right after
   * each recall answer that the agent's own raw turn follows: in the L1
   * prompt, an opened chunk or the raw middle that starts with the agent's
   * turn; in a merge prompt, an L2 target or the raw middle that does. A
   * recall answer is the message after a `[CM] Recall memory <id>.` header
   * (recallHeaderId), and it is the agent's, so a next message of the
   * answer's participant is what the collapse below joins to it, and the
   * formatter at the wire. The turn goes in when the message right after the
   * answer is of that participant, or the first one after it that has any
   * content is: the request drops a message with no content left once its
   * unpaired tool blocks and empty text are stripped (stripUnpairedToolBlocks,
   * stripEmptyTextBlocks and the filter after them), which would bring the
   * two together. Splitting and collapsing don't change which tool blocks are
   * paired, so they're stripped here as the request will strip them. Any
   * other sequence comes back with the same messages.
   */
  protected separateRecallAnswers(
    messages: Array<{ participant: string; content: ContentBlock[] }>,
  ): Array<{ participant: string; content: ContentBlock[] }> {
    const carried = stripUnpairedToolBlocks(messages);
    const hasContent = (i: number): boolean => stripEmptyTextBlocks(carried[i]!.content).length > 0;
    const separated: Array<{ participant: string; content: ContentBlock[] }> = [];
    messages.forEach((message, i) => {
      separated.push(message);
      if (i === 0 || recallHeaderId(messages[i - 1]!) === undefined) return;
      let withContent = i + 1;
      while (withContent < messages.length && !hasContent(withContent)) withContent++;
      if (messages[i + 1]?.participant === message.participant || messages[withContent]?.participant === message.participant) {
        separated.push({ participant: 'Context Manager', content: [{ type: 'text', text: RECALL_RESUME_TEXT }] });
      }
    });
    return separated;
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
    const cached = AutobiographicalStrategy._textOnlyTokens.get(msg);
    if (cached !== undefined) return cached;
    const tokens = AutobiographicalStrategy.computeTextOnlyTokens(msg);
    AutobiographicalStrategy._textOnlyTokens.set(msg, tokens);
    return tokens;
  }

  /** Pure per-message text-only estimate, cached on the message object like
   *  staticSalience (immutable content; the store keeps the object across
   *  appends). */
  private static _textOnlyTokens = new WeakMap<StoredMessage, number>();

  private static computeTextOnlyTokens(msg: StoredMessage): number {
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

  /**
   * Price a rendered body the way the store prices it. The plan and the
   * emission must agree: every recall pair, envelope and raw shard's text
   * this strategy prices here (the adaptive middle prices a joined run of
   * shards as the sum of its shards' prices) is later emitted and measured
   * against the same budget the store's calibrated estimate feeds, so the
   * store's view is the authority whenever one is bound (per-class
   * chars/token rates, the signed-thinking rule, the closed-loop calibration
   * multiplier). Before a view is bound the fallback mirrors the store's raw
   * rules. The old local rule priced text at a flat chars/4 — under
   * `carrierPolicy: 'live-strip'`, where the exact mint `tokens` no longer
   * floors the recall-pair price, that under-priced dense summary prose by
   * ~25-30% (2026-09-21, measured against count_tokens on a 500-summary
   * window: 526k planned, 728k real).
   */
  protected estimateTokens(content: ContentBlock[]): number {
    const view = this._storeView;
    if (view && typeof view.estimateTokens === 'function') {
      return view.estimateTokens({ content } as unknown as StoredMessage);
    }
    let tokens = 0;
    for (const block of content) {
      if (block.type === 'text') {
        tokens += defaultTokenEstimator(block.text);
      } else if (block.type === 'thinking') {
        // Mirrors MessageStore.computeBlockTokensRaw: a stamped estimate
        // wins; a signed block is a full hidden chain of thought priced by
        // the larger of its visible text and its signature length.
        const stamped = (block as { tokenEstimate?: number }).tokenEstimate;
        if (typeof stamped === 'number') {
          tokens += stamped;
        } else {
          const sig = (block as { signature?: string }).signature;
          const textTokens = defaultTokenEstimator(block.thinking ?? '');
          tokens += typeof sig === 'string' && sig.length > 0
            ? Math.max(textTokens, MessageStore.signedThinkingTokens(sig))
            : textTokens;
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
   * Build the assistant-turn content for a replayed summary. When the
   * entry carries verbatim `responseContent` (signed thinking /
   * redacted_thinking + text in provider order), replay it unmutated —
   * Fable-5/Sonnet-5-class models require the encrypted reasoning back
   * alongside their generated text, and the signatures only verify on
   * byte-identical blocks. Fallback for legacy/stub entries: a plain
   * text block from `content`.
   *
   * Returns a fresh array so callers can never mutate the stored entry.
   *
   * This is the MINT-SIDE answer, and carriers ride it unconditionally: the
   * mint/merge recall ladders and refusal-curve expansion all build here, and
   * the carriers' anti-refusal duty on that surface is measured (see
   * `carrierPolicy`). The live window builds from the same prose through
   * `liveWindowAnswerProse`, which is where `carrierPolicy` applies. Both
   * roads pass through `wrapRecallAnswerContent`, so the `recallEnvelope`
   * delimiter is still applied once per answer, whichever surface asked.
   */
  protected summaryAnswerContent(summary: SummaryEntry): ContentBlock[] {
    return wrapRecallAnswerContent(
      this.summaryAnswerProse(summary),
      summary,
      this.config.recallEnvelope,
    );
  }

  /**
   * The answer body BEFORE any envelope: verbatim `responseContent` when the
   * entry carries it, else a plain text block from `content`. Split out of
   * `summaryAnswerContent` so a capped render can truncate the prose and
   * envelope the result, rather than truncating an already-enveloped body.
   */
  protected summaryAnswerProse(summary: SummaryEntry): ContentBlock[] {
    if (summary.responseContent && summary.responseContent.length > 0) {
      return [...summary.responseContent];
    }
    return [{ type: 'text', text: summary.content }];
  }

  /**
   * The answer body for the LIVE WINDOW — the surface the agent whose memory
   * this is reads back — under `carrierPolicy`, or under `'live-strip'`
   * while thinking is bound (liveCarrierPolicy).
   *
   * Under `'full'` (default) this IS `summaryAnswerProse`, block for block.
   * Under `'live-strip'` the captured reasoning carriers are omitted from the
   * live render alone: whole blocks dropped, so the same entry's mint-side
   * recall still replays its signed blocks byte-verbatim. Mutating a carrier
   * here would break the signature that the mint surface depends on — hence
   * omission, never rewriting. Every surviving block is passed through by
   * reference, except a Responses item a stripped reasoning item led to: every
   * block that shares it, other than an opaque carrier, is copied without its
   * raw item, and so without its id (see raw-forms.ts).
   *
   * A carrier-only entry (reasoning captured, no prose block — degenerate, and
   * guarded against at mint time) would strip to an empty assistant turn,
   * which the API rejects outright. The fallback is the same plain text block
   * a legacy carrier-free entry renders, so the memory is still readable and
   * the turn is still valid.
   */
  protected liveWindowAnswerProse(summary: SummaryEntry): ContentBlock[] {
    const prose = this.summaryAnswerProse(summary);
    if (this.liveCarrierPolicy() !== 'live-strip') return prose;
    const stripped = stripThinkingBlocks(prose);
    const carriesProse = stripped.some(
      (block) => block.type === 'text' && block.text.trim().length > 0,
    );
    return carriesProse ? stripped : [{ type: 'text', text: summary.content }];
  }

  /**
   * `summaryAnswerContent` for the live window: the policy-filtered body under
   * the same envelope. Used where a live render is PRICED rather than emitted
   * (`recallPairCost`), so the plan and the emission agree about carriers.
   */
  protected liveWindowAnswerContent(summary: SummaryEntry): ContentBlock[] {
    return wrapRecallAnswerContent(
      this.liveWindowAnswerProse(summary),
      summary,
      this.config.recallEnvelope,
    );
  }

  /**
   * The legacy combined recall answer (`positionedRecallPairs: false`): every
   * selected summary concatenated into one assistant turn with `---`
   * separators, under a single `maxMessageTokens` cap.
   *
   * With the envelope off this is the pre-existing expression: concatenate,
   * then truncate the whole turn, so its bytes are exactly what the flat
   * truncator writes. That is the compatibility promise. The truncator now
   * writes an omission marker where it drops text, so a capped answer differs
   * from earlier versions' by that one block.
   *
   * With the envelope on the cap is spent summary by summary instead, each
   * summary's prose truncated against what the earlier ones left and then
   * enveloped intact. The emission shape matches the flat truncator's —
   * whole summaries until the budget runs out, the one that straddles it
   * with its prose cut inside an intact envelope (a truncation suffix on the
   * block the cap crosses, or the omission marker where the cap ends on a
   * block boundary), then one omission marker for what the cap left out,
   * unless that answer's own cut already wrote it. The answer ends at the
   * summary where the cap ended, whatever budget the blocks the cap left out
   * didn't spend, and a summary isn't admitted where the cap reaches it and
   * leaves nothing of it that holds anything, as for a prose that holds
   * nothing. An answer the cap admits no summary to is the marker alone.
   * Before the cap ends, a summary is left out
   * whole only where the budget can't pay for the separator in front of it
   * and a token of its prose, below.
   *
   * The drop-whole boundary sits at the SEPARATOR: a summary is admitted only
   * when the remaining budget can pay for the separator in front of it AND buy
   * at least one token of prose behind it. Deciding the other way round — the
   * separator charged after the summary it precedes was already emitted —
   * spends past the cap by the separator's own width plus whatever prose the
   * exhausted budget still bought, which is how one shared cap stops being
   * shared.
   *
   * Returns the answer together with what of it survived the cap: each
   * summary whose prose reached the answer, marked `partial` when the cap
   * took something of it that held anything. A summary the cap dropped
   * entirely is not listed, nor one that lost something that held anything
   * while only text blocks of it that hold nothing reached the answer, so the
   * rendered layout never claims history is represented by a summary the
   * resident was not shown.
   */
  protected renderCombinedRecallAnswer(
    summaries: SummaryEntry[],
    maxTokens: number,
  ): { content: ContentBlock[]; refs: Array<{ id: string; level: number; partial?: true }> } {
    // A separator follows the answer before it on the wire, so the reasoning at
    // that answer's end gives up its id first (see raw-forms.ts).
    const separated = (content: ContentBlock[]): ContentBlock[] => [
      ...releaseTrailingReasoning(content),
      { type: 'text', text: COMBINED_RECALL_SEPARATOR_TEXT },
    ];
    if (this.config.recallEnvelope !== 'xml') {
      let content: ContentBlock[] = [];
      // Which summary each text block of the full answer belongs to (-1 for
      // separators), so a flat truncation can be read back per summary.
      // releaseTrailingReasoning keeps every block's position, so the two
      // stay aligned.
      const owners: number[] = [];
      summaries.forEach((s, idx) => {
        if (idx > 0) {
          content = separated(content);
          owners.push(-1);
        }
        for (const block of this.liveWindowAnswerContent(s)) {
          content.push(block);
          owners.push(idx);
        }
      });
      const out = maxTokens > 0 ? this.truncateContent(content, maxTokens) : content;
      if (out === content) {
        return { content: out, refs: summaries.map((s) => ({ id: s.id, level: s.level })) };
      }
      // truncateContent keeps blocks in order: text until the budget runs
      // out (the straddling block cut), the omission marker where the first
      // dropped text block that held anything was, a text block that holds
      // nothing (isEmptyTextBlock) only before the cap, as it was or as a
      // copy that gave up a raw form, and every
      // non-text block, before the cap or past it (a tool_result possibly
      // shortened). Align the two arrays: an unchanged block is the same
      // object, and a cut, shortened or copied one (a copy that gave up a
      // raw form) is a new block of the same type in the same position. A
      // block that holds nothing loses nothing either way: kept, it may be
      // such a copy, which holds nothing too, and left out across or past
      // the cap, it has no counterpart. It's kept only where every block
      // before it was kept, as it was or as a copy, since across the cap the
      // cap ends there, so a counterpart that holds nothing is never a later
      // block's. The marker shows none of the block it replaces, and any
      // other dropped block has no counterpart. A text block that holds
      // nothing shows the resident nothing, so it counts as neither shown nor
      // lost. A block that holds anything is lost unless it reached the
      // answer as it was: a cut, or a copy that gave up its raw form and so no
      // longer replays as its item, loses something. A summary is listed whole
      // when it lost nothing and some block of it reached the answer, so one
      // that holds nothing is listed whole before the cap and absent once the
      // cap left it out. It's listed partial when it lost something and a
      // block of it that holds anything reached the answer, as it was, cut or
      // as a copy, including a retained thinking block whose text was
      // dropped. Otherwise it's absent: one the marker alone replaced, or of
      // which only blocks that hold nothing came before the marker, shows the
      // resident none of its history. The marker is told apart by identity
      // (isCapMarker), so a block whose text equals it, a copy included,
      // counts as the block it is.
      const kept = new Map<number, { whole: number; reached: number; shown: number; total: number }>();
      let j = 0;
      content.forEach((block, i) => {
        const owner = owners[i]!;
        const tally = owner >= 0 ? (kept.get(owner) ?? { whole: 0, reached: 0, shown: 0, total: 0 }) : null;
        if (tally) tally.total++;
        const counterpart = out[j];
        const blank = isEmptyTextBlock(block);
        if (counterpart === block) {
          j++;
          if (tally) { tally.whole++; tally.reached++; if (!blank) tally.shown++; }
        } else if (blank) {
          if (counterpart && isEmptyTextBlock(counterpart)) {
            j++;
            if (tally) tally.reached++;
          }
          if (tally) tally.whole++;
        } else if (counterpart && counterpart.type === block.type) {
          j++;
          if (tally && !isCapMarker(counterpart)) { tally.reached++; tally.shown++; }
        }
        if (tally) kept.set(owner, tally);
      });
      const refs: Array<{ id: string; level: number; partial?: true }> = [];
      summaries.forEach((s, idx) => {
        const tally = kept.get(idx);
        if (!tally) return;
        if (tally.whole === tally.total) {
          if (tally.reached > 0) refs.push({ id: s.id, level: s.level });
        } else if (tally.shown > 0) {
          refs.push({ id: s.id, level: s.level, partial: true });
        }
      });
      return { content: out, refs };
    }

    let content: ContentBlock[] = [];
    const refs: Array<{ id: string; level: number; partial?: true }> = [];
    const separatorCost = this.estimateTextOnlyTokens(
      { content: [{ type: 'text', text: COMBINED_RECALL_SEPARATOR_TEXT }] } as StoredMessage,
    );
    let remainingTokens = maxTokens;
    let admitted = 0;
    let omissionMarked = false;
    for (const [idx, s] of summaries.entries()) {
      const separatorTokens = idx > 0 ? separatorCost : 0;
      const proseBudget = remainingTokens - separatorTokens;
      if (maxTokens > 0 && proseBudget <= 0) break;
      const prose = this.liveWindowAnswerProse(s);
      const capped = maxTokens > 0 ? this.truncateContent(prose, proseBudget) : prose;
      // The cap reached this summary and left nothing of it that shows: every
      // block that survived holds nothing, besides the truncator's marker.
      // That's so for a prose that holds nothing, which comes back as the
      // marker alone, and for one whose only blocks before the cap hold
      // nothing. It isn't admitted, and the answer ends at it.
      if (capped !== prose && capped.every((b) => isEmptyTextBlock(b) || isCapMarker(b))) break;
      // Whether this answer, so far the last, carries the truncator's own
      // marker, told apart by identity from a block of the prose whose text
      // equals it (isCapMarker).
      omissionMarked = capped.some(isCapMarker);
      if (idx > 0) content = separated(content);
      content.push(...wrapRecallAnswerContent(capped, s, this.config.recallEnvelope));
      refs.push(cappedWhole(prose, capped) ? { id: s.id, level: s.level } : { id: s.id, level: s.level, partial: true });
      admitted++;
      // The cap ended inside this answer, where it cut, dropped or left out a
      // block, so the answer ends with it: no later summary is admitted,
      // whatever budget the blocks it left out didn't spend.
      if (capped !== prose) break;
      if (maxTokens > 0) {
        remainingTokens -=
          this.estimateTextOnlyTokens({ content: capped } as StoredMessage) + separatorTokens;
      }
    }
    // Summaries the cap left out are said once, as the flat truncator says
    // what it drops: after the last answer, whose trailing reasoning gives up
    // its id first, as it does before a separator. Not again if the last
    // answer's own prose already carries the marker, and not for summaries
    // whose prose held nothing, which a store can still keep from before
    // empty summaries were refused.
    const leftOutContent = summaries.slice(admitted)
      .some((s) => this.liveWindowAnswerProse(s).some((b) => !isEmptyTextBlock(b)));
    if (leftOutContent && !omissionMarked) {
      content = [...releaseTrailingReasoning(content), { type: 'text', text: CAP_OMISSION_TEXT }];
    }
    // The cap admitted no summary: nothing of the first that holds anything
    // survived it, and the cap ended there. The answer is the marker alone, as
    // the truncator gives content that holds nothing, so it's never empty, and
    // it lists none.
    if (admitted === 0 && summaries.length > 0) content = [{ type: 'text', text: CAP_OMISSION_TEXT }];
    return { content, refs };
  }

  /** The recall pair the adaptive middle emits for a folded run: the
   *  summary label's question, and the summary's answer rendered under the
   *  message cap, which ends the pair's layout unit. */
  private recallPairEntries(summary: SummaryEntry, msgCap: number, index: number): [ContextEntry, ContextEntry] {
    const rendered = this.renderSummaryAnswer(summary, msgCap);
    return [
      {
        index,
        participant: 'Context Manager',
        content: [{ type: 'text', text: this.config.summaryContextLabel ?? 'What do you remember from earlier?' }],
        sourceRelation: 'derived',
        summaries: rendered.refs,
      },
      {
        index: index + 1,
        participant: this.config.summaryParticipant ?? 'Claude',
        content: rendered.content,
        sourceRelation: 'derived',
        cacheLayoutKey: summary.id,
        summaries: rendered.refs,
      },
    ];
  }

  /**
   * A single recall answer for the live window, with its layout reference:
   * `liveWindowAnswerProse` cut to a `maxMessageTokens` cap, then wrapped in
   * the recall envelope. The cap is spent on the PROSE, and the envelope is
   * applied to what survives.
   *
   * Ordering is the whole point. Truncating an enveloped answer retains a
   * prefix and appends the truncator's own marker, which drops the closing
   * tag and — under a cap smaller than the opener — emits a half-written one:
   * a delimiter convention that sometimes lies is worse than no convention,
   * because the reader learns to distrust the tags that ARE intact. Wrapping
   * last makes opener and closer survive every cap by construction.
   *
   * The envelope is therefore NOT charged against `maxMessageTokens`; a
   * capped enveloped answer runs over the cap by its own tag text, and the
   * legacy combined answer under `recallEnvelope: 'xml'` also by the omission
   * marker it writes after its last envelope when summaries that hold anything
   * are left out, unless that answer's own cut already wrote it inside its
   * envelope. That is
   * the same soft-cap overshoot the truncator already takes for granted — it
   * appends its `[truncated — original was N tokens]` marker AFTER spending
   * the budget — and the envelope is priced where the accounting is load
   * bearing, in `capRecallPairs`. At a cap smaller than the envelope overhead
   * the render is opener + whatever prose the cap bought + marker + closer:
   * never an empty envelope, never a torn one.
   */
  protected renderSummaryAnswer(
    summary: SummaryEntry,
    maxTokens: number,
  ): { content: ContentBlock[]; refs: Array<{ id: string; level: number; partial?: true }> } {
    const prose = this.liveWindowAnswerProse(summary);
    const capped = maxTokens > 0 ? this.truncateContent(prose, maxTokens) : prose;
    return {
      content: wrapRecallAnswerContent(capped, summary, this.config.recallEnvelope),
      refs: [cappedWhole(prose, capped) ? { id: summary.id, level: summary.level } : { id: summary.id, level: summary.level, partial: true }],
    };
  }

  /**
   * Layout reporting: the messages each rendered summary covers (its leaf
   * messages, expanded through merged children), its level, and its method.
   * This strategy does not record who authored a summary, so the method is
   * 'unknown'.
   */
  describeRenderedSummaries(ids: readonly string[]): ReadonlyMap<string, RenderedSummaryInfo> {
    const byId = new Map<string, SummaryEntry>();
    for (const s of this.summaries) byId.set(s.id, s);
    const out = new Map<string, RenderedSummaryInfo>();
    for (const id of ids) {
      const summary = byId.get(id);
      if (!summary) continue;
      const leaves: string[] = [];
      const stack: string[] = [summary.id];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        const s = byId.get(next);
        if (!s) continue;
        if (s.sourceLevel === 0) leaves.push(...s.sourceIds);
        else stack.push(...s.sourceIds);
      }
      out.set(id, { level: summary.level, leaves, method: 'unknown' });
    }
    return out;
  }

  /** 'budget-fit' when the last committed adaptive select moved resolutions. */
  takeSelectionCause(): string | undefined {
    const cause = this.pendingSelectionCause;
    this.pendingSelectionCause = undefined;
    return cause;
  }

  /**
   * Cut a message's text and string tool-result content to `maxTokens`, with
   * the cap both strategies share (`capContent`, message-cap.ts). Whether it
   * looks is decided by `estimateTextOnlyTokens`, which counts thinking and
   * tool input too, so a thinking block alone can make it look. `estimate`,
   * when given, is that estimate for the content it's called with, such as
   * cappedForSend's, which gives a stored message's cached estimate for that
   * message's own content. This is the strategy's one cut: raw messages and
   * summaries alike go through it, so an override changes both, and the
   * price of a raw message follows what the override sends. A compile cuts
   * each message more than once, to price it and to send it, so an override
   * must answer the same arguments with the same content.
   */
  protected truncateContent(
    content: ContentBlock[],
    maxTokens: number,
    estimate?: (content: ContentBlock[]) => number,
  ): ContentBlock[] {
    return capContent(content, maxTokens, estimate ?? ((blocks) => this.estimateTextOnlyTokens({ content: blocks } as StoredMessage)));
  }

  /**
   * A stored message as this strategy sends it: its tool blocks as
   * toolPruning decides (prunedForSend), then cut under `maxMessageTokens`
   * (`msgCap`) by `truncateContent`, and what the cut adds to the price of
   * that pruned form (`cappedPriceExtra`). Pruning comes first, so the cap
   * never cuts a result that's replaced anyway. Each site that prices a raw
   * message as part of what a compile sends adds `extra` to the pruned
   * form's price (postStripEstimates in the adaptive selection, the pruned
   * form's estimate in the hierarchical one), so the message is priced as it
   * renders: the plan's chunks, the head and tail reservations, the
   * refusal's floor, the emission checks, the recent window's eviction walk
   * and the render stats.
   * The adaptive middle's shard path sends a body's raw shards' text uncut,
   * so their chunks' raw prices take no extra.
   * A site that emits the message sends `content`. None of the windows' sizes
   * is measured after the cap. The head window's size and the image strip's
   * depth are measured over the stored messages (getHeadWindowEnd,
   * getImageStripStart), the history that compression summarizes. The
   * recent window's is measured over each message's pruned form, after image
   * strips (getUnheldRecentWindowStart, through postStripEstimates). Whether
   * the cap cuts is decided, unless `truncateContent` is overridden, by
   * `estimateTextOnlyTokens` of the pruned form, the cut's own estimate,
   * which counts thinking and tool calls too and is cached on the message,
   * so a message under the cap costs each site a lookup.
   */
  protected cappedForSend(
    store: MessageStoreView,
    msg: StoredMessage,
    msgCap: number,
  ): { content: ContentBlock[]; extra: number } {
    // The default cut, capContent, reads a cap that isn't a positive number
    // as no cap, such as a caller's explicit `maxMessageTokens: undefined`,
    // which stays in the config, and returns the content itself, so the
    // extra is 0. The estimate is the message's cached one for its own
    // content, and otherwise of the content it's given, such as an
    // override's rewrite passed on to this class's cut.
    const sent = this.prunedForSend(store, msg);
    const content = this.truncateContent(sent.content, msgCap, (blocks) =>
      blocks === sent.content ? this.estimateTextOnlyTokens(sent) : this.estimateTextOnlyTokens({ content: blocks } as StoredMessage));
    return { content, extra: cappedPriceExtra(store, sent, content) };
  }

  /**
   * What a dry select puts back on every path out (see the dry branch in
   * `select`), saved now: the returned function puts it back. A dry select
   * and `renderAsNewest` share it, so a render leaves what the next compile
   * reads as it found it.
   */
  private saveDryRunState(store: MessageStoreView): () => void {
    const saved = {
      chunks: this.chunks,
      compressionQueue: this.compressionQueue,
      compressionQueueGeneration: this.compressionQueueGeneration,
      // The dry rebuild orders its queue (orderCompressionQueue), which prunes
      // the failure orders, runs and window waits of chunks its own cut
      // doesn't have, and the failure orders and runs of merges not queued
      // now. A dry select commits nothing, so all of them are put back as
      // they were.
      compressionFailureOrder: new Map(this.compressionFailureOrder),
      compressionNotBefore: new Map(this.compressionNotBefore),
      mergeFailureOrder: new Map(this.mergeFailureOrder),
      compressionFailureRuns: new Map(this.compressionFailureRuns),
      mergeFailureRuns: new Map(this.mergeFailureRuns),
      chunkRecordsOrphaned: this.chunkRecordsOrphaned,
      orphanWarned: this._orphanWarned,
      prevCacheKeys: this._prevCacheKeys,
      lastFrontierTokens: this.lastFrontierTokens,
      transitionBlocked: this.transitionBlocked,
      lastRenderStats: this._lastRenderStats,
      lastCompileEstimate: this._lastCompileEstimate,
      calibrationArmed: this._calibrationArmed,
      calibrationLoaded: this._calibrationLoaded,
      calibration: this._calibration,
      calibrationReset: this._calibrationReset,
      calibrationProvisional: this._calibrationProvisional,
      storeCalibration: store.getTokenCalibration?.(),
      storeView: this._storeView,
      storeOrder: this._storeOrder,
      storeOrderSource: this._storeOrderSource,
      headStartMemo: this._cachedHeadStartIndex,
    };
    return () => {
      this.chunks = saved.chunks;
      this.compressionQueue = saved.compressionQueue;
      this.compressionQueueGeneration = saved.compressionQueueGeneration;
      this.compressionFailureOrder = saved.compressionFailureOrder;
      this.compressionNotBefore = saved.compressionNotBefore;
      this.mergeFailureOrder = saved.mergeFailureOrder;
      this.compressionFailureRuns = saved.compressionFailureRuns;
      this.mergeFailureRuns = saved.mergeFailureRuns;
      this.chunkRecordsOrphaned = saved.chunkRecordsOrphaned;
      this._orphanWarned = saved.orphanWarned;
      this._prevCacheKeys = saved.prevCacheKeys;
      this.lastFrontierTokens = saved.lastFrontierTokens;
      this.transitionBlocked = saved.transitionBlocked;
      this._lastRenderStats = saved.lastRenderStats;
      this._lastCompileEstimate = saved.lastCompileEstimate;
      this._calibrationArmed = saved.calibrationArmed;
      this._calibrationLoaded = saved.calibrationLoaded;
      this._calibration = saved.calibration;
      this._calibrationReset = saved.calibrationReset;
      this._calibrationProvisional = saved.calibrationProvisional;
      if (saved.storeCalibration !== undefined) store.setTokenCalibration?.(saved.storeCalibration);
      this._storeView = saved.storeView;
      this._storeOrder = saved.storeOrder;
      this._storeOrderSource = saved.storeOrderSource;
      this._cachedHeadStartIndex = saved.headStartMemo;
    };
  }

  /**
   * See `ContextStrategy.renderAsNewest`. The steps a compile takes for the
   * messages it sends last and as they stand, over the view's suffix from the
   * batch's oldest message to its newest: each stored copy cut as
   * `cappedForSend` cuts it, a body's shards joined by
   * `mergeAdjacentBodyGroupRaw` under adaptive resolution (the hierarchical
   * select sends each shard as its own message), then `applyImageStripping`,
   * so a message stored after the batch counts toward the images as in a
   * compile. The tool pass that comes between them (postProcessToolEntries)
   * is left out: it pairs and prunes by the window around these messages.
   *
   * Those messages are the recent window's, and the head window's too when
   * no message comes between the two: a compile places the middle's
   * messages, and the history before a head window that was reset, after
   * the head. The hierarchical select can also place summaries there, which
   * are text and change no image decision. A message before them comes back
   * as null.
   *
   * It takes a compile's steps before its windows as a dry select takes
   * them: it rebuilds the chunks, then, under adaptive resolution, loads the
   * calibration, and it puts back what a dry select puts back, so it prices
   * as the next compile will and leaves what that compile reads as it found
   * it.
   */
  renderAsNewest(store: MessageStoreView, ids: readonly MessageId[]): Array<ContentBlock[] | null> {
    this.requireLoadedBranch('renderAsNewest');
    const restore = this.saveDryRunState(store);
    this._dryRunSelect = true;
    try {
      this.rebuildChunks(store);
      if (this.config.adaptiveResolution) this.loadCalibration(store, { dryRun: true });
      const messages = store.getAll();
      const posById = this.positionIndex(messages);
      const headStart = this.getHeadWindowStartIndex(store);
      const headEnd = this.getHeadWindowEnd(store);
      const tailStart = Math.max(this.getRecentWindowStart(store), headEnd);
      const start = headStart === 0 && headEnd === tailStart ? 0 : tailStart;
      const msgCap = this.config.maxMessageTokens;
      // As selectPath chooses: only the adaptive select joins a body's
      // shards, so only there does an id stand for its whole body.
      const joins = this.config.adaptiveResolution;
      // Each id's whole body, read back by its first shard's id, which the
      // merge keeps; one that starts before the suffix has none.
      const firstOf = new Map<MessageId, MessageId>();
      let from = messages.length;
      for (const id of ids) {
        const at = posById.get(id);
        if (at === undefined) continue;
        const body = joins ? bodyBoundsIn(messages, at) : { from: at, to: at };
        if (body.from < start) continue;
        firstOf.set(id, messages[body.from]!.id);
        from = Math.min(from, body.from);
      }
      const entries: ContextEntry[] = [];
      for (let k = from; k < messages.length; k++) {
        const msg = messages[k]!;
        entries.push({
          index: entries.length,
          sourceMessageId: msg.id,
          sourceRelation: 'copy',
          participant: msg.participant,
          content: this.cappedForSend(store, msg, msgCap).content,
        });
      }
      const merged = joins ? this.mergeAdjacentBodyGroupRaw(entries, store, messages) : entries;
      this.applyImageStripping(merged, store);
      const rendered = new Map<MessageId, ContentBlock[]>();
      for (const entry of merged) {
        if (entry.sourceMessageId !== undefined) rendered.set(entry.sourceMessageId, entry.content);
      }
      return ids.map((id) => {
        const first = firstOf.get(id);
        return first === undefined ? null : rendered.get(first) ?? null;
      });
    } finally {
      this._dryRunSelect = false;
      restore();
    }
  }
}
