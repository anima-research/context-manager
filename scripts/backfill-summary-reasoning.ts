/**
 * Backfill `responseContent` (signed thinking / redacted_thinking + text)
 * onto existing autobiographical SummaryEntry records from membrane
 * llm-calls debug logs.
 *
 * Background (2026-07-15): Fable-5/Sonnet-5-class models require encrypted
 * reasoning tokens to be supplied back alongside model-generated text that
 * is replayed as an assistant turn. Summaries are replayed in the agent's
 * own voice, but until context-manager ce95b68 every compression site
 * stored the summarizer response TEXT-ONLY — the reasoning blocks (and
 * their signatures) were dropped. They still exist verbatim inside the
 * membrane debug logs (`llm-calls.*.jsonl`), one record per API call, with
 * the full raw response content. This tool matches stored summaries back
 * to those logged responses by exact text and stamps the recovered blocks
 * onto the entries.
 *
 * Matching: the generation code stored `content` as the response's text
 * blocks joined with '\n'. We index every logged response by that same
 * joined text → exact-match lookup, no heuristics. A trimmed-text fallback
 * index catches records that differ only by leading/trailing whitespace.
 *
 * Writes: per-slot `editStateItem` on the persisted summaries state (the
 * same pattern as AutobiographicalStrategy.setMergedInto) — every stored
 * copy sharing the entry id is updated, all other slots keep their exact
 * bytes. NEVER a whole-array Set: smaller blast radius, and immune to the
 * Set-on-AppendLog resurrection class by construction.
 *
 * DRY-RUN by default; pass --apply to write.
 * ALWAYS: stop the agent, back up the session dir, validate on a copy
 * first (deploy order per the chronicle playbook: pull → scan → repair →
 * restart).
 *
 * Usage:
 *   node dist/scripts/backfill-summary-reasoning.js <store-path> <namespace> \
 *     <llm-calls-file-or-dir> [more files/dirs...] [--apply] [--report=path.json]
 * e.g.
 *   node dist/scripts/backfill-summary-reasoning.js \
 *     ~/mythos-cm/data/sessions/2f115c98 agents/mythos \
 *     ~/mythos-cm/data/sessions/2f115c98/llm-calls.*.jsonl
 *
 * Accepts .jsonl and .jsonl.gz (gunzipped in memory). Directories are
 * scanned (non-recursive) for llm-calls*.jsonl{,.gz}.
 */

import { JsStore } from '@animalabs/chronicle';
import { readFileSync, readdirSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';

interface ReasoningBlock {
  type: 'thinking' | 'redacted_thinking' | 'text';
  thinking?: string;
  signature?: string;
  data?: string;
  text?: string;
  /**
   * Exact replay price stamped from the logged usage (thinking token
   * count). Signature-only blocks otherwise price at the hidden-CoT
   * default (600) — measured production blocks run 112–394, so stamping
   * keeps fold/recall budget estimates honest. Honored by both
   * message-store and AutobiographicalStrategy.estimateTokens.
   */
  tokenEstimate?: number;
}

interface SummaryEntry {
  id: string;
  level: number;
  content: string;
  responseContent?: ReasoningBlock[];
  [k: string]: unknown;
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const reportArg = argv.find(a => a.startsWith('--report='));
const positional = argv.filter(a => !a.startsWith('--'));
const [storePath, namespace, ...logInputs] = positional;
if (!storePath || !namespace || logInputs.length === 0) {
  console.error(
    'usage: backfill-summary-reasoning <store-path> <namespace> <llm-calls file/dir>... [--apply] [--report=path.json]',
  );
  process.exit(2);
}

// ---------- collect log files ----------
const logFiles: string[] = [];
for (const input of logInputs) {
  const st = statSync(input, { throwIfNoEntry: false });
  if (!st) {
    console.warn(`skip (missing): ${input}`);
    continue;
  }
  if (st.isDirectory()) {
    for (const f of readdirSync(input)) {
      if (/^llm-calls.*\.jsonl(\.gz)?$/.test(f)) logFiles.push(join(input, f));
    }
  } else {
    logFiles.push(input);
  }
}
if (logFiles.length === 0) {
  console.error('no llm-calls files found in the given inputs');
  process.exit(2);
}

// ---------- response extraction ----------
/**
 * Pull a content-block array out of one llm-calls JSONL record, tolerating
 * the shapes seen in the wild: `rawResponse.content`,
 * `rawResponse.response.content` (RawAccess wrapper), `response.content`.
 */
function extractContent(rec: Record<string, unknown>): unknown[] | null {
  const candidates = [
    (rec as { rawResponse?: { content?: unknown } }).rawResponse?.content,
    (rec as { rawResponse?: { response?: { content?: unknown } } }).rawResponse?.response?.content,
    (rec as { response?: { content?: unknown } }).response?.content,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return null;
}

/** Thinking-token count from the record's usage, wherever it lives. */
function extractThinkingTokens(rec: Record<string, unknown>): number | undefined {
  const usages = [
    (rec as { rawResponse?: { usage?: unknown } }).rawResponse?.usage,
    (rec as { rawResponse?: { response?: { usage?: unknown } } }).rawResponse?.response?.usage,
    (rec as { response?: { usage?: unknown } }).response?.usage,
  ];
  for (const u of usages) {
    if (!u || typeof u !== 'object') continue;
    const usage = u as Record<string, unknown>;
    const cand =
      usage.thinking_tokens ??
      usage.thinkingTokens ??
      (usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens;
    if (typeof cand === 'number' && cand > 0) return cand;
  }
  return undefined;
}

/** Normalize provider raw blocks to membrane-shaped reasoning/text blocks. */
function normalizeBlocks(blocks: unknown[]): ReasoningBlock[] | null {
  const out: ReasoningBlock[] = [];
  let hasReasoning = false;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as Record<string, unknown>;
    if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
      hasReasoning = true;
      const t: ReasoningBlock = { type: 'thinking', thinking: blk.thinking };
      if (typeof blk.signature === 'string' && blk.signature.length > 0) t.signature = blk.signature;
      out.push(t);
    } else if (blk.type === 'redacted_thinking' && typeof blk.data === 'string') {
      hasReasoning = true;
      out.push({ type: 'redacted_thinking', data: blk.data });
    } else if (blk.type === 'text' && typeof blk.text === 'string') {
      out.push({ type: 'text', text: blk.text });
    }
    // anything else (tool_use etc.) has no place in a replayed summary turn
  }
  return hasReasoning ? out : null;
}

function joinedText(blocks: ReasoningBlock[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text as string).join('\n');
}

// ---------- index logged responses by summary text ----------
const byText = new Map<string, ReasoningBlock[]>();
const byTrimmedText = new Map<string, ReasoningBlock[]>();
let records = 0;
let reasoningRecords = 0;
let conflicts = 0;

function indexRecord(line: string): void {
  if (!line.trim()) return;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return; // torn tail line from rotation — expected, skip
  }
  records++;
  const content = extractContent(rec);
  if (!content) return;
  const blocks = normalizeBlocks(content);
  if (!blocks) return;
  reasoningRecords++;
  // Stamp exact replay prices onto signature-only thinking blocks from the
  // logged usage (split evenly across blocks when there are several).
  const thinkingTokens = extractThinkingTokens(rec);
  if (thinkingTokens) {
    const hidden = blocks.filter(
      b => b.type === 'thinking' && (!b.thinking || b.thinking.length === 0) && b.signature,
    );
    for (const b of hidden) b.tokenEstimate = Math.ceil(thinkingTokens / hidden.length);
  }
  const text = joinedText(blocks);
  if (!text.trim()) return;
  const existing = byText.get(text);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(blocks)) conflicts++;
    return; // first record wins — deterministic, and retries are near-identical
  }
  byText.set(text, blocks);
  const trimmed = text.trim();
  if (!byTrimmedText.has(trimmed)) byTrimmedText.set(trimmed, blocks);
}

async function indexFile(path: string): Promise<void> {
  if (path.endsWith('.gz')) {
    const buf = gunzipSync(readFileSync(path));
    for (const line of buf.toString('utf8').split('\n')) indexRecord(line);
    return;
  }
  // Plain files can be tens of GB — stream, never slurp.
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
  for await (const line of rl) indexRecord(line);
}

console.log(`indexing ${logFiles.length} log file(s)...`);
for (const f of logFiles) {
  const before = reasoningRecords;
  await indexFile(f);
  console.log(`  ${basename(f)}: +${reasoningRecords - before} reasoning responses`);
}
console.log(
  `indexed ${records} records → ${reasoningRecords} with reasoning blocks, ` +
    `${byText.size} unique response texts (${conflicts} same-text conflicts, first kept)`,
);

// ---------- load summaries & match ----------
const SUMS = `${namespace}/autobio:summaries`;
const store = JsStore.open({ path: storePath });
const rawSums = store.getStateJson(SUMS);
const stored: Array<SummaryEntry | null> = Array.isArray(rawSums) ? rawSums : [];

const isStub = (s: SummaryEntry) => s.content.startsWith('(A quiet stretch');

let already = 0;
let stubs = 0;
const matchedSlots = new Map<number, ReasoningBlock[]>(); // persisted slot index → blocks
const matchedIds = new Set<string>();
const unmatched: SummaryEntry[] = [];
const seenIds = new Set<string>();

for (let i = 0; i < stored.length; i++) {
  const s = stored[i];
  if (!s || typeof s.content !== 'string' || !s.content.trim()) continue;
  if (Array.isArray(s.responseContent) && s.responseContent.length > 0) {
    if (!seenIds.has(s.id)) already++;
    seenIds.add(s.id);
    continue;
  }
  if (isStub(s)) {
    if (!seenIds.has(s.id)) stubs++;
    seenIds.add(s.id);
    continue;
  }
  const blocks = byText.get(s.content) ?? byTrimmedText.get(s.content.trim());
  if (blocks) {
    matchedSlots.set(i, blocks);
    matchedIds.add(s.id);
  } else if (!seenIds.has(s.id)) {
    unmatched.push(s);
  }
  seenIds.add(s.id);
}
// An id counts as unmatched only if NO copy of it matched.
const trulyUnmatched = unmatched.filter(s => !matchedIds.has(s.id));

// ---------- report ----------
const byLevel = (list: Iterable<SummaryEntry>) => {
  const m = new Map<number, number>();
  for (const s of list) m.set(s.level, (m.get(s.level) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l}:${n}`).join(' ') || '—';
};
const matchedEntries = [...matchedSlots.keys()].map(i => stored[i] as SummaryEntry);
const uniqueMatched = new Map(matchedEntries.map(s => [s.id, s]));

console.log(`\nstore:     ${storePath}`);
console.log(`namespace: ${namespace}`);
console.log(`summaries: ${seenIds.size} unique ids in ${stored.length} slots`);
console.log(`  already have responseContent: ${already}`);
console.log(`  stubs (mechanical, exempt):   ${stubs}`);
console.log(`  MATCHED (backfillable):       ${uniqueMatched.size}  [${byLevel(uniqueMatched.values())}]  (${matchedSlots.size} slots)`);
console.log(`  UNMATCHED (no logged resp.):  ${trulyUnmatched.length}  [${byLevel(trulyUnmatched)}]`);
if (trulyUnmatched.length > 0) {
  const fmt = (n: number) => new Date(n).toISOString().slice(0, 10);
  const dates = trulyUnmatched
    .map(s => (typeof s.created === 'number' ? s.created : 0))
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (dates.length > 0) {
    console.log(`  unmatched created range:      ${fmt(dates[0])} .. ${fmt(dates[dates.length - 1])}`);
  }
}

if (reportArg) {
  const path = reportArg.slice('--report='.length);
  writeFileSync(
    path,
    JSON.stringify(
      {
        storePath,
        namespace,
        matched: [...uniqueMatched.keys()],
        unmatched: trulyUnmatched.map(s => ({ id: s.id, level: s.level, created: s.created, head: s.content.slice(0, 80) })),
        already,
        stubs,
      },
      null,
      2,
    ),
  );
  console.log(`report written: ${path}`);
}

if (!apply) {
  console.log('\nDRY RUN — nothing written. Pass --apply to write (agent stopped + backup taken first!).');
  store.close();
  process.exit(0);
}

// ---------- apply: per-slot edits, setMergedInto pattern ----------
let edited = 0;
for (const [slot, blocks] of matchedSlots) {
  const s = stored[slot] as SummaryEntry;
  const updated = { ...s, responseContent: blocks };
  store.editStateItem(SUMS, slot, Buffer.from(JSON.stringify(updated)));
  edited++;
}
store.close();
console.log(`\nAPPLIED: stamped responseContent onto ${edited} slot(s) (${uniqueMatched.size} unique summaries).`);
console.log('Restart the agent to load the backfilled entries.');
