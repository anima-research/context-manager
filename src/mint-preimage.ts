import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import type { NormalizedRequest } from '@animalabs/membrane';

/**
 * Durable preimages for the requests that authored memories.
 *
 * A minted summary records `provenance.requestHash` — sha256 of the
 * JSON-serialized membrane request that produced it. Until this module the
 * hash keyed an `llm-calls` log this library never wrote: hosts that set
 * `CONTEXT_MANAGER_COMPRESSION_LOG` got telemetry (attempt traces, truncated
 * message summaries), hosts that didn't got nothing, and either way the
 * exact bytes behind the hash survived only in whatever the harness happened
 * to keep. A hash you can verify but not read is provenance only while
 * somebody else's log lives.
 *
 * For text-only requests, Chronicle's blob store closes that gap without a
 * wrapper or new filesystem convention: `storeBlob` keys content by sha256 of
 * the bytes — the SAME digest `sha256Json` computes for `requestHash` — so the
 * preimage is retrievable under the hash the summary already carries,
 * deduplicated across retries for free, and durable in the same store the
 * summary itself persists to.
 *
 * INLINE MEDIA IS NOT RE-EMBEDDED (maintainer review, PR #79). A mint request
 * replays raw history, so a single preimage can carry megabytes of base64
 * image content, and content-addressing cannot dedupe it: the blob key is the
 * hash of the WHOLE request and no two mints send the same request. That was
 * the dominant growth term, unbounded over a long-lived store. A media-bearing
 * preimage therefore persists as an ENVELOPE: the request's own JSON text
 * split into literal spans and references to content-addressed media blobs in
 * the same store, keyed by `requestHash` in a Chronicle tree state. Media that
 * `MessageStore` already extracted reuses its existing blob; any other inline
 * media is stored once. `getMintRequestPreimageBytes` restores the exact
 * original base64 spelling, splices it back in, and verifies the result, so
 * the feature's contract is unchanged and enforced at both ends:
 * `sha256(returned) === requestHash`, byte for byte.
 */
const MINT_REQUEST_PREIMAGE_CONTENT_TYPE = 'application/json';

/**
 * Chronicle tree state mapping `requestHash` -> envelope blob. A tree state is
 * the store's own path-keyed index (point lookups, branch-visible like the
 * summaries it serves); the envelope itself is an ordinary blob. Text-only
 * preimages never touch it — they stay keyed by their own digest, exactly as
 * before, so the common path carries no envelope overhead at all.
 */
const MINT_PREIMAGE_ENVELOPE_INDEX_STATE_ID = 'mint-preimage-envelopes';

const MINT_PREIMAGE_ENVELOPE_VERSION = 1;

interface Base64Whitespace {
  at: number;
  text: string;
}

interface Base64EncodingForm {
  alphabet: 'standard' | 'url' | 'mixed';
  paddingChars: number;
  urlSafePositions?: number[];
  whitespace?: Base64Whitespace[];
}

type MintPreimageSegment =
  | { kind: 'literal'; text: string }
  | { kind: 'mediaBlob'; blobHash: string; encoding: Base64EncodingForm };

interface MintPreimageEnvelope {
  version: number;
  segments: MintPreimageSegment[];
}

interface InlineBase64Media {
  data: string;
  mediaType: string;
  jsonStart: number;
  jsonEnd: number;
}

type JsonSpan =
  | { kind: 'string'; start: number; end: number }
  | { kind: 'array'; items: JsonSpan[] }
  | { kind: 'object'; fields: Map<string, JsonSpan> }
  | { kind: 'scalar' };

/**
 * A stored envelope exists but its bytes cannot be reproduced — a referenced
 * media blob is gone, the envelope is from an unknown version, or the spliced
 * result does not hash back to the key it was stored under. All three mean a
 * damaged store rather than an absent preimage, so they are loud: `null` from
 * the read APIs keeps its narrow meaning of "nothing was persisted here".
 */
export class MintPreimageMaterializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MintPreimageMaterializationError';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class JsonSpanParser {
  private cursor = 0;

  constructor(private readonly json: string) {}

  parse(): JsonSpan {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.cursor !== this.json.length) {
      throw new SyntaxError(`unexpected JSON content at byte ${this.cursor}`);
    }
    return value;
  }

  private parseValue(): JsonSpan {
    this.skipWhitespace();
    const current = this.json[this.cursor];
    if (current === '"') return this.parseString();
    if (current === '{') return this.parseObject();
    if (current === '[') return this.parseArray();
    return this.parseScalar();
  }

  private parseString(): Extract<JsonSpan, { kind: 'string' }> {
    const start = this.cursor;
    this.expect('"');
    let escaped = false;
    while (this.cursor < this.json.length) {
      const current = this.json[this.cursor]!;
      this.cursor++;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === '\\') {
        escaped = true;
        continue;
      }
      if (current === '"') {
        return { kind: 'string', start, end: this.cursor };
      }
    }
    throw new SyntaxError(`unterminated JSON string at byte ${start}`);
  }

  private parseObject(): Extract<JsonSpan, { kind: 'object' }> {
    const fields = new Map<string, JsonSpan>();
    this.expect('{');
    this.skipWhitespace();
    if (this.json[this.cursor] === '}') {
      this.cursor++;
      return { kind: 'object', fields };
    }
    while (true) {
      const keySpan = this.parseString();
      const key = decodeJsonString(this.json, keySpan);
      this.skipWhitespace();
      this.expect(':');
      fields.set(key, this.parseValue());
      this.skipWhitespace();
      const delimiter = this.json[this.cursor];
      this.cursor++;
      if (delimiter === '}') return { kind: 'object', fields };
      if (delimiter !== ',') {
        throw new SyntaxError(`expected ',' or '}' at byte ${this.cursor - 1}`);
      }
      this.skipWhitespace();
    }
  }

  private parseArray(): Extract<JsonSpan, { kind: 'array' }> {
    const items: JsonSpan[] = [];
    this.expect('[');
    this.skipWhitespace();
    if (this.json[this.cursor] === ']') {
      this.cursor++;
      return { kind: 'array', items };
    }
    while (true) {
      items.push(this.parseValue());
      this.skipWhitespace();
      const delimiter = this.json[this.cursor];
      this.cursor++;
      if (delimiter === ']') return { kind: 'array', items };
      if (delimiter !== ',') {
        throw new SyntaxError(`expected ',' or ']' at byte ${this.cursor - 1}`);
      }
      this.skipWhitespace();
    }
  }

  private parseScalar(): Extract<JsonSpan, { kind: 'scalar' }> {
    const start = this.cursor;
    while (
      this.cursor < this.json.length &&
      !/[\s,\]}]/.test(this.json[this.cursor]!)
    ) {
      this.cursor++;
    }
    JSON.parse(this.json.slice(start, this.cursor));
    return { kind: 'scalar' };
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.json[this.cursor] ?? '')) this.cursor++;
  }

  private expect(expected: string): void {
    if (this.json[this.cursor] !== expected) {
      throw new SyntaxError(`expected '${expected}' at byte ${this.cursor}`);
    }
    this.cursor++;
  }
}

function decodeJsonString(
  json: string,
  span: Extract<JsonSpan, { kind: 'string' }>,
): string {
  return JSON.parse(json.slice(span.start, span.end)) as string;
}

function jsonStringValue(json: string, span: JsonSpan | undefined): string | null {
  return span?.kind === 'string' ? decodeJsonString(json, span) : null;
}

function collectInlineBase64Media(
  json: string,
  span: JsonSpan,
  found: InlineBase64Media[] = [],
): InlineBase64Media[] {
  if (span.kind === 'array') {
    for (const item of span.items) collectInlineBase64Media(json, item, found);
    return found;
  }
  if (span.kind !== 'object') return found;
  const type = jsonStringValue(json, span.fields.get('type'));
  const dataSpan = span.fields.get('data');
  const data = jsonStringValue(json, dataSpan);
  const mediaType = type === 'base64'
    ? jsonStringValue(json, span.fields.get('mediaType'))
    : type === 'generated_image'
      ? jsonStringValue(json, span.fields.get('mimeType'))
      : null;
  if (dataSpan?.kind === 'string' && data !== null && mediaType !== null) {
    found.push({
      data,
      mediaType,
      jsonStart: dataSpan.start,
      jsonEnd: dataSpan.end,
    });
    return found;
  }
  for (const nested of span.fields.values()) {
    collectInlineBase64Media(json, nested, found);
  }
  return found;
}

function applyBase64EncodingForm(
  bytes: Buffer,
  encoding: Base64EncodingForm,
): string | null {
  const canonical = bytes.toString('base64');
  const canonicalBody = canonical.replace(/=+$/, '');
  const canonicalPaddingChars = canonical.length - canonicalBody.length;
  if (
    encoding.paddingChars !== 0 &&
    encoding.paddingChars !== canonicalPaddingChars
  ) {
    return null;
  }

  let body = canonicalBody;
  if (encoding.alphabet === 'url') {
    body = body.replace(/\+/g, '-').replace(/\//g, '_');
  } else if (encoding.alphabet === 'mixed') {
    const parts: string[] = [];
    let cursor = 0;
    for (const at of encoding.urlSafePositions ?? []) {
      const current = canonicalBody[at];
      if (at < cursor || (current !== '+' && current !== '/')) return null;
      parts.push(canonicalBody.slice(cursor, at), current === '+' ? '-' : '_');
      cursor = at + 1;
    }
    parts.push(canonicalBody.slice(cursor));
    body = parts.join('');
  }

  const symbols = body + '='.repeat(encoding.paddingChars);
  if (!encoding.whitespace || encoding.whitespace.length === 0) return symbols;
  const parts: string[] = [];
  let cursor = 0;
  for (const whitespace of encoding.whitespace) {
    if (whitespace.at < cursor || whitespace.at > symbols.length) return null;
    parts.push(symbols.slice(cursor, whitespace.at), whitespace.text);
    cursor = whitespace.at;
  }
  parts.push(symbols.slice(cursor));
  return parts.join('');
}

function parseBase64EncodingForm(
  data: string,
): { bytes: Buffer; encoding: Base64EncodingForm } | null {
  const whitespace: Base64Whitespace[] = [];
  let removedChars = 0;
  const symbols = data.replace(/[ \t\r\n]+/g, (text: string, offset: number) => {
    whitespace.push({ at: offset - removedChars, text });
    removedChars += text.length;
    return '';
  });
  const padding = /=+$/.exec(symbols)?.[0] ?? '';
  if (padding.length > 2) return null;
  const body = padding.length > 0 ? symbols.slice(0, -padding.length) : symbols;
  if (body.includes('=') || !/^[A-Za-z0-9+/_-]*$/.test(body)) return null;
  const remainder = body.length % 4;
  if (remainder === 1) return null;
  const canonicalPaddingChars = remainder === 0 ? 0 : 4 - remainder;
  if (padding.length !== 0 && padding.length !== canonicalPaddingChars) return null;

  const standardBody = body.replace(/-/g, '+').replace(/_/g, '/');
  const canonical = standardBody + '='.repeat(canonicalPaddingChars);
  const bytes = Buffer.from(canonical, 'base64');
  if (bytes.toString('base64') !== canonical) return null;

  const hasStandardAlphabet = /[+/]/.test(body);
  const hasUrlAlphabet = /[-_]/.test(body);
  const alphabet = hasUrlAlphabet
    ? hasStandardAlphabet
      ? 'mixed'
      : 'url'
    : 'standard';
  const urlSafePositions = alphabet === 'mixed'
    ? [...body.matchAll(/[-_]/g)].map((match) => match.index)
    : undefined;
  const encoding: Base64EncodingForm = {
    alphabet,
    paddingChars: padding.length,
    ...(urlSafePositions ? { urlSafePositions } : {}),
    ...(whitespace.length > 0 ? { whitespace } : {}),
  };
  return applyBase64EncodingForm(bytes, encoding) === data
    ? { bytes, encoding }
    : null;
}

function buildPreimageEnvelope(
  store: JsStore,
  requestJson: string,
): MintPreimageEnvelope | null {
  const json = new JsonSpanParser(requestJson).parse();
  const media = collectInlineBase64Media(requestJson, json);
  const segments: MintPreimageSegment[] = [];
  let cursor = 0;
  for (const { data, mediaType, jsonStart, jsonEnd } of media) {
    const parsed = parseBase64EncodingForm(data);
    if (parsed === null) continue;
    const blobHash = store.storeBlob(parsed.bytes, mediaType);
    segments.push({ kind: 'literal', text: requestJson.slice(cursor, jsonStart) });
    segments.push({ kind: 'mediaBlob', blobHash, encoding: parsed.encoding });
    cursor = jsonEnd;
  }
  if (segments.length === 0) return null;
  segments.push({ kind: 'literal', text: requestJson.slice(cursor) });
  return { version: MINT_PREIMAGE_ENVELOPE_VERSION, segments };
}

/**
 * Splice an envelope back into request bytes, or null when a referenced media
 * blob is no longer in the store.
 */
function materializeEnvelope(store: JsStore, envelope: MintPreimageEnvelope): Buffer | null {
  const parts: Buffer[] = [];
  for (const segment of envelope.segments) {
    if (segment.kind === 'literal') {
      parts.push(Buffer.from(segment.text, 'utf8'));
      continue;
    }
    const blob = store.getBlob(segment.blobHash);
    if (blob === null) return null;
    const base64 = applyBase64EncodingForm(blob, segment.encoding);
    if (base64 === null) return null;
    parts.push(Buffer.from(JSON.stringify(base64), 'utf8'));
  }
  return Buffer.concat(parts);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseBase64EncodingFormRecord(value: unknown): Base64EncodingForm {
  const record = requireRecord(value, 'media encoding');
  const alphabet = record.alphabet;
  const paddingChars = record.paddingChars;
  if (alphabet !== 'standard' && alphabet !== 'url' && alphabet !== 'mixed') {
    throw new TypeError('media encoding alphabet is invalid');
  }
  if (
    !Number.isSafeInteger(paddingChars) ||
    (paddingChars as number) < 0 ||
    (paddingChars as number) > 2
  ) {
    throw new TypeError('media encoding paddingChars is invalid');
  }

  let urlSafePositions: number[] | undefined;
  if (alphabet === 'mixed') {
    if (!Array.isArray(record.urlSafePositions)) {
      throw new TypeError('mixed media encoding requires urlSafePositions');
    }
    urlSafePositions = [];
    let previous = -1;
    for (const position of record.urlSafePositions) {
      if (
        !Number.isSafeInteger(position) ||
        (position as number) <= previous
      ) {
        throw new TypeError('media encoding urlSafePositions is invalid');
      }
      previous = position as number;
      urlSafePositions.push(previous);
    }
  }

  let whitespace: Base64Whitespace[] | undefined;
  if (record.whitespace !== undefined) {
    if (!Array.isArray(record.whitespace)) {
      throw new TypeError('media encoding whitespace is invalid');
    }
    whitespace = [];
    let previous = -1;
    for (const item of record.whitespace) {
      const whitespaceRecord = requireRecord(item, 'media encoding whitespace');
      const at = whitespaceRecord.at;
      const text = whitespaceRecord.text;
      if (
        !Number.isSafeInteger(at) ||
        (at as number) < previous
      ) {
        throw new TypeError('media encoding whitespace position is invalid');
      }
      if (typeof text !== 'string' || !/^[ \t\r\n]+$/.test(text)) {
        throw new TypeError('media encoding whitespace text is invalid');
      }
      previous = at as number;
      whitespace.push({ at: previous, text });
    }
  }

  return {
    alphabet,
    paddingChars: paddingChars as number,
    ...(urlSafePositions ? { urlSafePositions } : {}),
    ...(whitespace ? { whitespace } : {}),
  };
}

function parseEnvelopeRecord(
  value: unknown,
  requestHash: string,
): MintPreimageEnvelope {
  const record = requireRecord(value, 'mint preimage envelope');
  if (typeof record.version !== 'number') {
    throw new TypeError('mint preimage envelope version must be a number');
  }
  if (record.version !== MINT_PREIMAGE_ENVELOPE_VERSION) {
    throw new MintPreimageMaterializationError(
      `mint preimage envelope for ${requestHash} is version ${record.version}, ` +
        `this build reads version ${MINT_PREIMAGE_ENVELOPE_VERSION}`,
    );
  }
  if (!Array.isArray(record.segments)) {
    throw new TypeError('mint preimage envelope segments must be an array');
  }
  const segments = record.segments.map((value, index): MintPreimageSegment => {
    const segment = requireRecord(value, `mint preimage envelope segment ${index}`);
    if (segment.kind === 'literal' && typeof segment.text === 'string') {
      return { kind: 'literal', text: segment.text };
    }
    if (segment.kind === 'mediaBlob' && typeof segment.blobHash === 'string') {
      return {
        kind: 'mediaBlob',
        blobHash: segment.blobHash,
        encoding: parseBase64EncodingFormRecord(segment.encoding),
      };
    }
    throw new TypeError(`mint preimage envelope segment ${index} is invalid`);
  });
  return { version: record.version, segments };
}

function readEnvelope(store: JsStore, requestHash: string): MintPreimageEnvelope | null {
  const indexed = store.treeGet(MINT_PREIMAGE_ENVELOPE_INDEX_STATE_ID, requestHash);
  if (indexed === null) return null;
  const bytes = store.getBlob(indexed.blobHash);
  if (bytes === null) {
    throw new MintPreimageMaterializationError(
      `mint preimage envelope ${indexed.blobHash} for ${requestHash} is indexed but its blob is gone`,
    );
  }
  try {
    return parseEnvelopeRecord(JSON.parse(bytes.toString('utf8')) as unknown, requestHash);
  } catch (cause) {
    if (cause instanceof MintPreimageMaterializationError) throw cause;
    throw new MintPreimageMaterializationError(
      `mint preimage envelope for ${requestHash} is malformed`,
      { cause },
    );
  }
}

function storeEnvelope(store: JsStore, envelope: MintPreimageEnvelope, requestHash: string): void {
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  const blobHash = store.storeBlob(bytes, MINT_REQUEST_PREIMAGE_CONTENT_TYPE);
  try {
    store.registerState({ id: MINT_PREIMAGE_ENVELOPE_INDEX_STATE_ID, strategy: 'tree' });
  } catch { /* already registered */ }
  store.treeSet(MINT_PREIMAGE_ENVELOPE_INDEX_STATE_ID, requestHash, {
    blobHash,
    size: bytes.length,
    mode: 0,
  });
}

/**
 * Store the exact bytes `requestHash` was computed over, keyed by that hash.
 *
 * Text-only requests are stored as themselves — one content-addressed blob
 * under their own digest. Requests carrying inline media are stored as an
 * envelope (module doc above) whose splice is verified byte-for-byte BEFORE it
 * is indexed; a request whose envelope fails that check falls back to the
 * plain form, so a preimage is never left readable-but-wrong.
 *
 * Never throws. A memory outranks its receipt: a store that refuses the blob
 * (disk full, closed store) must not lose the summary the LLM just paid for,
 * so failures are loud on stderr and non-fatal — the same stance
 * `logCompressionCall` takes. A hash mismatch means the request object
 * mutated between hashing and persistence; the preimage is still written
 * (under its true key) and the divergence is reported rather than papered
 * over.
 */
export function persistMintRequestPreimage(
  store: JsStore,
  request: NormalizedRequest,
  requestHash: string,
): void {
  try {
    const requestJson = JSON.stringify(request);
    const preimage = Buffer.from(requestJson, 'utf8');
    const trueHash = sha256(preimage);
    if (trueHash !== requestHash) {
      console.error(
        `[mint-preimage] preimage stored under ${trueHash} but provenance keys ${requestHash} — ` +
          'the authoring request changed between hashing and persistence; the preimage is readable ' +
          'under the STORED key only',
      );
    }
    const envelope = buildPreimageEnvelope(store, requestJson);
    if (envelope !== null) {
      const materialized = materializeEnvelope(store, envelope);
      if (materialized !== null && materialized.equals(preimage)) {
        storeEnvelope(store, envelope, trueHash);
        return;
      }
      console.error(
        `[mint-preimage] envelope for ${trueHash} did not splice back to the request bytes — ` +
          'storing the whole request instead',
      );
    }
    store.storeBlob(preimage, MINT_REQUEST_PREIMAGE_CONTENT_TYPE);
  } catch (error) {
    console.error(`[mint-preimage] failed to persist request preimage ${requestHash}:`, error);
  }
}

/**
 * Raw preimage bytes for a `provenance.requestHash`, or null.
 *
 * Null has three causes, all of them ordinary — a summary carrying
 * provenance is never evidence that its preimage is readable:
 *  1. the mint predates this module;
 *  2. it ran without `persistMintPreimages: true`;
 *  3. persistence was attempted and FAILED. Storage is best-effort by
 *     design (`persistMintRequestPreimage` above): a store that refuses the
 *     blob must not cost the summary the LLM just paid for, so the failure
 *     is loud on stderr and the mint lands with a hash whose preimage was
 *     never written.
 *
 * A media-bearing preimage is spliced back together from its envelope here
 * (module doc above) and the result is re-hashed before it is returned, so
 * the guarantee is the same either way:
 * `createHash('sha256').update(bytes).digest('hex') === requestHash`. Verify
 * it yourself if you like — what you get back IS the request the summary was
 * authored from, not a reconstruction of it. A damaged store (missing media
 * blob, unreadable envelope, splice that does not hash back) throws
 * `MintPreimageMaterializationError` rather than returning null.
 */
export function getMintRequestPreimageBytes(
  store: JsStore,
  requestHash: string,
): Buffer | null {
  const plain = store.getBlob(requestHash);
  if (plain !== null) return plain;
  const envelope = readEnvelope(store, requestHash);
  if (envelope === null) return null;
  let materialized: Buffer | null;
  try {
    materialized = materializeEnvelope(store, envelope);
  } catch (cause) {
    if (cause instanceof MintPreimageMaterializationError) throw cause;
    throw new MintPreimageMaterializationError(
      `mint preimage ${requestHash} could not be materialized`,
      { cause },
    );
  }
  if (materialized === null) {
    throw new MintPreimageMaterializationError(
      `mint preimage ${requestHash} references media blobs this store no longer has`,
    );
  }
  const materializedHash = sha256(materialized);
  if (materializedHash !== requestHash) {
    throw new MintPreimageMaterializationError(
      `mint preimage ${requestHash} materialized to ${materializedHash} — the envelope and the ` +
        'blobs it references no longer reproduce the authoring request',
    );
  }
  return materialized;
}

/**
 * The authoring request behind a `provenance.requestHash`, parsed, or null
 * when no preimage was persisted for it (three causes — see
 * `getMintRequestPreimageBytes`).
 *
 * Throws if the hash names a blob that is not a stored request (media blobs
 * live in the same content-addressed space) — a wrong hash should be loud,
 * not silently null.
 */
export function getMintRequestByHash(
  store: JsStore,
  requestHash: string,
): NormalizedRequest | null {
  const bytes = getMintRequestPreimageBytes(store, requestHash);
  if (bytes === null) return null;
  return JSON.parse(bytes.toString('utf8')) as NormalizedRequest;
}
