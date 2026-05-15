/**
 * Deterministic chunker for messages that exceed `chunkThreshold` tokens.
 *
 * Splits a message body into shards such that concatenating the shards in
 * order reproduces the original body byte-for-byte. Each shard is identified
 * by a stable `sourceHash` so re-ingesting the same content produces
 * identical shard boundaries (and reuses any existing L_k summaries via the
 * archive's hash-keyed lookup).
 *
 * Strategy:
 *  1. Structural pass — split at markdown headings, code-fence boundaries,
 *     blank-line paragraph breaks. Prefer larger structural units when they
 *     fit under `chunkSize`.
 *  2. Token-bucket fallback — when a structural unit alone exceeds
 *     `chunkSize`, split it at paragraph or line boundaries until each
 *     resulting piece fits.
 *  3. Last-resort hard split — only when no structural seam exists in the
 *     piece (e.g., one very long line). Splits at the largest UTF-8-safe
 *     position under the threshold.
 *
 * See `docs/adaptive-resolution-design.md` §3.6.
 */

import { createHash } from 'node:crypto';

export interface ChunkerOptions {
  /**
   * Messages with token count strictly greater than this are chunked.
   * Messages at or below are passed through unchanged.
   * Default: 8192.
   */
  chunkThreshold: number;

  /**
   * Target token count per shard. The chunker aims for shards close to
   * but not exceeding this size. Default: 4096.
   */
  chunkSize: number;

  /**
   * Approximate characters per token. Used for size estimation since we
   * can't easily run a tokenizer here. Default: 4.0. The picker uses
   * cached real token counts; the chunker only needs approximate sizing.
   */
  charsPerToken: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  chunkThreshold: 8192,
  chunkSize: 4096,
  charsPerToken: 4.0,
};

export interface Shard {
  /** Order of this shard within its bodyGroup, starting at 0. */
  index: number;
  /** Byte offsets into the original body. [start, end) — UTF-8 byte positions. */
  range: { startByte: number; endByte: number };
  /** Shard content (a substring of the original body). */
  content: string;
  /** SHA-256 of the shard content. */
  sourceHash: string;
  /** Approximate token count (chars / charsPerToken, rounded). */
  approxTokens: number;
}

export interface ShardingResult {
  /** True if the message was split into multiple shards. */
  wasSharded: boolean;
  /** The shards. If wasSharded is false, exactly one shard containing the entire body. */
  shards: Shard[];
  /** The stable group id for these shards (sha256 of the full original body, prefixed). */
  bodyGroupId: string;
}

/**
 * Chunk a message body. Pure function — no side effects.
 */
export function chunkMessage(body: string, options: Partial<ChunkerOptions> = {}): ShardingResult {
  const opts: ChunkerOptions = { ...DEFAULT_CHUNKER_OPTIONS, ...options };
  const totalApproxTokens = Math.ceil(body.length / opts.charsPerToken);
  const bodyHash = hashOf(body);
  const bodyGroupId = `bg-${bodyHash.slice(0, 16)}`;

  if (totalApproxTokens <= opts.chunkThreshold) {
    return {
      wasSharded: false,
      bodyGroupId,
      shards: [
        {
          index: 0,
          range: { startByte: 0, endByte: byteLength(body) },
          content: body,
          sourceHash: bodyHash,
          approxTokens: totalApproxTokens,
        },
      ],
    };
  }

  // Build a list of split points — preferred seams in priority order.
  // Each seam is a byte offset into the body. The chunker walks the body
  // and emits shards by greedily accumulating content up to chunkSize at
  // the highest-quality seam available.
  const seams = findSeams(body);
  const targetChars = opts.chunkSize * opts.charsPerToken;
  const maxChars = opts.chunkSize * opts.charsPerToken * 1.25; // 25% overflow tolerance to land on a clean seam

  const shards: Shard[] = [];
  let cursor = 0;
  let index = 0;
  const bodyByteLen = byteLength(body);

  while (cursor < body.length) {
    // Find the best seam to split at, given the [cursor, cursor + maxChars] window.
    const windowEnd = Math.min(cursor + maxChars, body.length);
    const targetEnd = Math.min(cursor + targetChars, body.length);

    let splitAt: number;
    if (windowEnd >= body.length) {
      splitAt = body.length;
    } else {
      splitAt = bestSeamIn(seams, cursor, targetEnd, windowEnd, body);
    }

    // Ensure forward progress: if no seam found and we'd produce an empty
    // shard, take a hard split at the targetEnd.
    if (splitAt <= cursor) {
      splitAt = safeCharBoundary(body, targetEnd);
    }

    const content = body.slice(cursor, splitAt);
    const startByte = byteLengthOf(body, 0, cursor);
    const endByte = startByte + byteLength(content);
    shards.push({
      index,
      range: { startByte, endByte },
      content,
      sourceHash: hashOf(content),
      approxTokens: Math.ceil(content.length / opts.charsPerToken),
    });
    cursor = splitAt;
    index += 1;
  }

  // Sanity: byte-faithful reassembly
  const reassembled = shards.map((s) => s.content).join('');
  if (reassembled !== body) {
    throw new Error(
      `chunker: shard reassembly mismatch (original=${body.length} chars, reassembled=${reassembled.length} chars)`
    );
  }
  if (shards[shards.length - 1].range.endByte !== bodyByteLen) {
    throw new Error(
      `chunker: byte-range mismatch (expected end=${bodyByteLen}, got=${shards[shards.length - 1].range.endByte})`
    );
  }

  return {
    wasSharded: true,
    bodyGroupId,
    shards,
  };
}

/**
 * Identify candidate split seams in the body, returned as character offsets.
 * Each seam has a priority — higher = more preferred (split here if possible).
 *
 * Priorities (higher is better):
 *  100 = markdown H1/H2 heading (after the heading line)
 *   90 = markdown H3+ heading
 *   80 = code-fence end (closing ```)
 *   70 = blank line (paragraph break)
 *   50 = single newline
 *   30 = sentence end (period/question mark/exclamation + space)
 *   10 = word boundary (whitespace)
 *
 * Returns a sorted array by offset ascending.
 */
interface Seam {
  offset: number; // character offset (split happens BEFORE this character — actually at this offset)
  priority: number;
}

function findSeams(body: string): Seam[] {
  const seams: Seam[] = [];

  // Markdown headings: ^(#+)\s
  // Match at line starts.
  const headingRe = /(?:^|\n)(#{1,6})\s[^\n]*\n/g;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    const hashes = m[1];
    // Position is just before the heading's newline so the heading itself
    // starts the next shard (cleaner visual boundary).
    const lineStart = m.index === 0 ? 0 : m.index + 1;
    if (lineStart === 0) continue; // can't split at the start
    seams.push({
      offset: lineStart,
      priority: hashes.length <= 2 ? 100 : 90,
    });
  }

  // Code-fence boundaries.
  const fenceRe = /\n```[^\n]*\n/g;
  while ((m = fenceRe.exec(body)) !== null) {
    seams.push({ offset: m.index + 1, priority: 80 });
  }

  // Blank lines (paragraph breaks): \n\n
  const blankRe = /\n\n+/g;
  while ((m = blankRe.exec(body)) !== null) {
    // Position is just after the last \n in the sequence, so the next
    // shard begins at the non-blank content.
    seams.push({ offset: m.index + m[0].length, priority: 70 });
  }

  // Single newlines.
  const nlRe = /\n/g;
  while ((m = nlRe.exec(body)) !== null) {
    seams.push({ offset: m.index + 1, priority: 50 });
  }

  // Sentence ends.
  const sentRe = /[.!?]\s+/g;
  while ((m = sentRe.exec(body)) !== null) {
    seams.push({ offset: m.index + m[0].length, priority: 30 });
  }

  // Word boundaries (any whitespace).
  const wsRe = /\s+/g;
  while ((m = wsRe.exec(body)) !== null) {
    seams.push({ offset: m.index + m[0].length, priority: 10 });
  }

  // Deduplicate by offset, keeping highest priority.
  const byOffset = new Map<number, number>();
  for (const s of seams) {
    const prev = byOffset.get(s.offset);
    if (prev === undefined || prev < s.priority) byOffset.set(s.offset, s.priority);
  }

  return Array.from(byOffset.entries())
    .map(([offset, priority]) => ({ offset, priority }))
    .sort((a, b) => a.offset - b.offset);
}

/**
 * Find the highest-priority seam in (cursor, windowEnd] that falls at or
 * before targetEnd if possible, otherwise the closest after targetEnd up to
 * windowEnd. Returns the chosen split offset.
 */
function bestSeamIn(
  seams: Seam[],
  cursor: number,
  targetEnd: number,
  windowEnd: number,
  body: string
): number {
  // Binary search for the first seam strictly > cursor.
  let lo = 0;
  let hi = seams.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (seams[mid].offset <= cursor) lo = mid + 1;
    else hi = mid;
  }

  let bestPreTarget: Seam | null = null;
  let bestPostTarget: Seam | null = null;

  for (let i = lo; i < seams.length; i++) {
    const s = seams[i];
    if (s.offset > windowEnd) break;
    if (s.offset <= targetEnd) {
      if (!bestPreTarget || s.priority > bestPreTarget.priority || (s.priority === bestPreTarget.priority && s.offset > bestPreTarget.offset)) {
        bestPreTarget = s;
      }
    } else {
      if (!bestPostTarget || s.priority > bestPostTarget.priority || (s.priority === bestPostTarget.priority && s.offset < bestPostTarget.offset)) {
        bestPostTarget = s;
      }
    }
  }

  // Prefer the best seam at or before target.
  if (bestPreTarget) return bestPreTarget.offset;
  if (bestPostTarget) return bestPostTarget.offset;
  // No seams in window — hard split at a UTF-8-safe boundary near target.
  return safeCharBoundary(body, targetEnd);
}

/**
 * Return an offset ≤ target that doesn't fall inside a UTF-16 surrogate pair.
 * The chunker operates on JS strings (UTF-16); splitting inside a surrogate
 * pair would corrupt the output.
 */
function safeCharBoundary(body: string, target: number): number {
  if (target >= body.length) return body.length;
  if (target <= 0) return 0;
  const code = body.charCodeAt(target);
  // If we'd split before a low surrogate, back up one.
  if (code >= 0xdc00 && code <= 0xdfff) {
    return target - 1;
  }
  return target;
}

/** UTF-8 byte length of a JS string. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** UTF-8 byte length of body[start..end] without allocating the slice when possible. */
function byteLengthOf(body: string, start: number, end: number): number {
  if (start === 0 && end === 0) return 0;
  return Buffer.byteLength(body.slice(start, end), 'utf8');
}

function hashOf(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
