/**
 * Scan a chronicle store for CORRUPTED CANONIZED MEMORIES — summaries that
 * were persisted from an incomplete/refused generation before the
 * terminal-disposition gate (cm a544a5c, 2026-08-01) existed.
 *
 * Background: executeMerge (and the L1 canonical path for non-refusal stops)
 * persisted ANY nonempty response text without checking stopReason. A
 * safety-classifier interruption can fire MID-MESSAGE at any point, so a
 * corrupted memory is not necessarily short — but it nearly always cuts
 * mid-sentence. Detection therefore keys on:
 *
 *   HIGH:   refusal phrasing anywhere in the content;
 *           tail cut mid-flow (dangling function word, trailing comma/
 *           hyphen/opening bracket or quote);
 *   MEDIUM: no sentence-terminal punctuation at the end (markdown lists
 *           legitimately do this — inspect before judging).
 *
 * Entries with provenance.stopReason === 'end_turn' are gate-verified and
 * skipped. Everything else (pre-gate) is scanned.
 *
 * READ-ONLY: opens the raw JsStore, never writes. Still — run against a
 * COPY when the store belongs to a live agent (open contends with the
 * agent's LOCK):  cp -R <store> /tmp/scan-copy && bun scripts/scan-corrupt-memories.ts /tmp/scan-copy
 *
 * Usage:
 *   bun scripts/scan-corrupt-memories.ts <store-path> [--json <out.json>] [--medium] [--tail <n>]
 *     --json    write full findings as JSON
 *     --medium  include medium-confidence (no-terminal-punct) findings in stdout listing
 *     --tail    chars of content tail to print (default 160)
 */

import { existsSync, writeFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { SummaryEntry } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Refusal-template phrasing (classifier-shaped).
 *
 * IMPORTANT fleet caveat: residents DISCUSS refusals and classifiers
 * constantly (reasoning_extraction is daily ops vocabulary), so a match in
 * the MIDDLE of a long diary entry is meta-talk, not corruption. A real
 * refusal-as-content either REPLACES the summary (match near the start) or
 * is appended at the cut point (match at the very end). Only those
 * positions count as high-confidence; mid-content matches are reported as
 * info-only `refusal_mention`.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /\bI can(?:'t|not) (?:help|assist|continue|provide|engage|create|produce|summarize|analyz)/i,
  /\bI(?:'m| am) (?:not able|unable|not going) to (?:help|assist|continue|provide|summarize|create|produce)/i,
  /\bI (?:won't|will not) be able to\b/i,
  /\bcannot (?:assist|help) with\b/i,
  /\bI apologize,? but I (?:can|won'|will|am)/i,
  /\bI (?:don't|do not) feel comfortable\b/i,
  /\bagainst my (?:guidelines|principles|values)\b/i,
  /\brelates? to cyber\b/i,
  /\bI need to (?:stop|decline|pause) here\b/i,
];

/**
 * Function words that essentially never end a complete English sentence.
 * A summary whose last word is one of these was cut mid-flow.
 */
const DANGLING_WORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'but', 'nor', 'with', 'in', 'on',
  'at', 'for', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'that', 'which', 'whose', 'its', 'their', 'his', 'her', 'my',
  'our', 'your', 'this', 'these', 'those', 'into', 'onto', 'over', 'under',
  'between', 'during', 'without', 'within', 'because', 'so', 'than', 'then',
  'when', 'while', 'where', 'we', 'they', 'he', 'she', 'i', 'you', 'not',
  'no', 'very', 'more', 'most', 'each', 'every', 'both', 'either', 'neither',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall',
  'has', 'have', 'had', 'do', 'does', 'did', 'about', 'against', 'through',
  'per', 'via', 'if', 'unless', 'until', 'toward', 'towards', 'upon', 'whom',
  'am', "i'm", "it's", "there's", "that's", "he's", "she's", "we're",
  "they're", "you're", "isn't", "aren't", "wasn't", "weren't", "don't",
  "doesn't", "didn't", "won't", "wouldn't", "couldn't", "shouldn't", "can't",
  "cannot", 'also', 'just', 'only', 'even', 'still', 'yet', 'rather', 'quite',
  'such', 'some', 'any', 'all', 'few', 'several', 'many', 'much', 'own',
  'same', 'other', 'another', 'what', 'who', 'how', 'why', 'whether',
]);

/** Characters that legitimately terminate a complete summary. */
const TERMINAL_CHARS = new Set([
  '.', '!', '?', '…', '"', "'", '’', '”', ')', ']', '}', '`', '*',
  '_', '~', ';', '>', '|', '—',
]);

interface Signal {
  kind:
    | 'refusal_phrase'
    | 'refusal_mention'
    | 'dangling_word'
    | 'trailing_comma'
    | 'trailing_hyphen'
    | 'trailing_opener'
    | 'no_terminal_punct';
  detail: string;
}

/**
 * Whether a final character legitimately terminates a summary. Beyond the
 * ASCII terminal set, any non-ASCII symbol (emoji sign-offs like 🐉🪔, CJK
 * punctuation, arrows, variation selectors) counts as terminal — residents
 * end diary entries with emoji constantly, and a classifier cut never
 * stops ON an emoji flourish.
 */
function isTerminalChar(ch: string): boolean {
  if (TERMINAL_CHARS.has(ch)) return true;
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x2000 && !(cp >= 0x2010 && cp <= 0x2015) /* dashes stay non-terminal except — */
    ? true
    : cp === 0x2014; // em-dash
}

function assess(content: string): { signals: Signal[]; confidence: 'high' | 'medium' | null } {
  const signals: Signal[] = [];

  // Refusal phrasing: position decides meaning (see REFUSAL_PATTERNS note).
  // Head match = refusal REPLACED the summary. Tail match counts only when
  // the refusal sentence actually runs to the end of the content (the
  // appended-at-cut shape) — a quoted refusal inside a finished closing
  // paragraph is meta-talk.
  const headZone = content.slice(0, 300);
  const tailZone = content.slice(-300);
  const tailZoneStart = Math.max(0, content.length - 300);
  const contentEnd = content.replace(/[\s*_~`>|]+$/, '');
  for (const pattern of REFUSAL_PATTERNS) {
    // "Replaced content" shape: the refusal must START the summary (allow a
    // little leading whitespace/markdown), not merely appear early.
    const headMatch = pattern.exec(headZone);
    const inHead = headMatch && headMatch.index < 40 ? headMatch : null;
    const inTail = pattern.exec(tailZone);
    // "Runs to end": no completed sentence followed by further prose between
    // the match and the end of content.
    const tailMatchRunsToEnd = inTail
      ? !/[.!?…]["'’”)\]]*\s+\S/.test(contentEnd.slice(tailZoneStart + inTail.index))
      : false;
    const anywhere = inHead ?? inTail ?? pattern.exec(content);
    if (inHead || (inTail && tailMatchRunsToEnd)) {
      signals.push({ kind: 'refusal_phrase', detail: (inHead ?? inTail)![0] });
      break;
    }
    if (anywhere) {
      signals.push({ kind: 'refusal_mention', detail: anywhere[0] });
      break;
    }
  }

  // Tail-cut detection: the classifier can fire mid-message at any point,
  // and it nearly always cuts mid-sentence — the tail is the tell.
  const trimmed = content.replace(/[\s*_~`>|]+$/, ''); // ignore trailing whitespace/markdown dressing
  const chars = [...trimmed];
  const lastChar = chars[chars.length - 1] ?? '';
  const lastWordMatch = /([A-Za-z][A-Za-z'’-]*)$/.exec(trimmed);
  const lastWord = lastWordMatch?.[1]?.toLowerCase().replace(/’/g, "'");

  if (lastChar === ',') {
    signals.push({ kind: 'trailing_comma', detail: `...${trimmed.slice(-30)}` });
  } else if (lastChar === '-' || lastChar === '–') {
    // "mid-" — a hyphen at the very end is a mid-word cut. (Em-dash — is a
    // legitimate rhetorical ending, handled in isTerminalChar.)
    signals.push({ kind: 'trailing_hyphen', detail: `...${trimmed.slice(-30)}` });
  } else if (lastChar === '(' || lastChar === '[' || lastChar === '{' ||
             lastChar === '“' || lastChar === '‘') {
    signals.push({ kind: 'trailing_opener', detail: `...${trimmed.slice(-30)}` });
  } else if (lastWord && DANGLING_WORDS.has(lastWord)) {
    signals.push({ kind: 'dangling_word', detail: lastWord });
  } else if (lastChar && !isTerminalChar(lastChar)) {
    signals.push({ kind: 'no_terminal_punct', detail: `...${trimmed.slice(-30)}` });
  }

  const high = signals.some((s) => s.kind !== 'no_terminal_punct' && s.kind !== 'refusal_mention');
  if (high) return { signals, confidence: 'high' };
  if (signals.some((s) => s.kind === 'no_terminal_punct')) return { signals, confidence: 'medium' };
  return { signals, confidence: null };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface Finding {
  stateId: string;
  id: string;
  level: number;
  tokens: number;
  contentLength: number;
  created?: string;
  parentId?: string;
  sourceIds: number;
  confidence: 'high' | 'medium';
  signals: Signal[];
  head: string;
  tail: string;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: scan-corrupt-memories <store-path> [--json <out.json>] [--medium] [--tail <n>]');
    process.exit(1);
  }
  const storePath = args[0]!;
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
  const showMedium = args.includes('--medium');
  const tailIdx = args.indexOf('--tail');
  const tailChars = tailIdx >= 0 ? Number(args[tailIdx + 1]) || 160 : 160;

  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    process.exit(1);
  }

  const store = JsStore.open({ path: storePath });
  const summaryStates = store
    .listStates()
    .map((s) => s.id)
    .filter((id) => /autobio:summaries$/.test(id));

  if (summaryStates.length === 0) {
    console.log(`No autobio:summaries states in ${storePath} (branch: ${store.currentBranch().name}).`);
    return;
  }

  const findings: Finding[] = [];
  let scanned = 0;
  let gateVerified = 0;
  let emptyOrStub = 0;
  const levelCounts = new Map<number, number>();

  for (const stateId of summaryStates) {
    const value = store.getStateJson(stateId);
    if (!Array.isArray(value)) continue;
    for (const raw of value as SummaryEntry[]) {
      if (!raw || typeof raw.content !== 'string') continue;
      if (!raw.content.trim()) {
        emptyOrStub++;
        continue;
      }
      scanned++;
      levelCounts.set(raw.level, (levelCounts.get(raw.level) ?? 0) + 1);
      if (raw.provenance?.stopReason === 'end_turn') {
        gateVerified++;
        continue;
      }
      const { signals, confidence } = assess(raw.content);
      if (!confidence) continue;
      findings.push({
        stateId,
        id: raw.id,
        level: raw.level,
        tokens: raw.tokens,
        contentLength: raw.content.length,
        ...(raw.created ? { created: new Date(raw.created).toISOString() } : {}),
        ...(raw.parentId ?? raw.mergedInto
          ? { parentId: raw.parentId ?? raw.mergedInto }
          : {}),
        sourceIds: raw.sourceIds?.length ?? 0,
        confidence,
        signals,
        head: raw.content.slice(0, 100).replace(/\s+/g, ' '),
        tail: raw.content.slice(-tailChars).replace(/\s+/g, ' '),
      });
    }
  }

  // High first, then merges (the uncovered path) before L1s, then newest first.
  findings.sort((a, b) =>
    (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1) ||
    b.level - a.level ||
    (b.created ?? '').localeCompare(a.created ?? ''));

  const high = findings.filter((f) => f.confidence === 'high');
  const medium = findings.filter((f) => f.confidence === 'medium');

  console.log('=== corrupted-memory scan (terminal-disposition audit) ===');
  console.log(`Store: ${storePath}  (branch: ${store.currentBranch().name})`);
  console.log(`Summary states: ${summaryStates.join(', ')}`);
  console.log(
    `Entries scanned: ${scanned} ` +
      `(${[...levelCounts.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l}:${n}`).join(' ')})` +
      `${gateVerified ? `, ${gateVerified} gate-verified (skipped)` : ''}` +
      `${emptyOrStub ? `, ${emptyOrStub} empty/stub` : ''}`,
  );
  console.log(`HIGH confidence: ${high.length}   medium (no-terminal-punct only): ${medium.length}`);

  const toPrint = showMedium ? findings : high;
  for (const f of toPrint) {
    console.log('');
    console.log(
      `[${f.confidence.toUpperCase()}] ${f.id} (L${f.level}, ${f.tokens} tok, ${f.contentLength} chars` +
        `${f.created ? `, ${f.created.slice(0, 10)}` : ''}${f.parentId ? `, merged→${f.parentId}` : ''}) ` +
        `@ ${f.stateId}`,
    );
    console.log(`  signals: ${f.signals.map((s) => `${s.kind}(${s.detail})`).join(', ')}`);
    console.log(`  head: ${f.head}`);
    console.log(`  tail: ...${f.tail}`);
  }
  if (!showMedium && medium.length > 0) {
    console.log(`\n(${medium.length} medium-confidence finding(s) suppressed — rerun with --medium to list.)`);
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ storePath, scanned, gateVerified, findings }, null, 2));
    console.log(`\nJSON written: ${jsonOut}`);
  }
}

main();
