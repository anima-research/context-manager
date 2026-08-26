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
 * Chronicle's blob store closes that gap with no new format and no new
 * filesystem convention: `storeBlob` keys content by sha256 of the bytes —
 * the SAME digest `sha256Json` computes for `requestHash` — so a text-only
 * preimage written here is retrievable under the hash the summary already
 * carries, deduplicated across retries for free, and durable in the same
 * store the summary itself persists to.
 *
 * INLINE MEDIA IS NOT RE-EMBEDDED (maintainer review, PR #79). A mint request
 * replays raw history, so a single preimage can carry megabytes of base64
 * image content, and content-addressing cannot dedupe it: the blob key is the
 * hash of the WHOLE request and no two mints send the same request. That was
 * the dominant growth term, unbounded over a long-lived store. The image bytes
 * are already in this store — `MessageStore` extracts every base64 media
 * source to a content-addressed blob on add (`BlobManager`) — so a
 * media-bearing preimage persists as an ENVELOPE: the request's own JSON text
 * split into literal spans and references to those existing blobs, keyed by
 * `requestHash` in a Chronicle tree state. `getMintRequestPreimageBytes`
 * splices the base64 back in at read time and verifies the result, so the
 * feature's contract is unchanged and enforced at both ends:
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

/**
 * Base64 payloads below this stay inline in the envelope's literal text: a
 * blob record per thumbnail costs more than the bytes it saves, and the growth
 * term the review names is megabyte-scale image content.
 */
const MIN_EXTRACTED_BASE64_CHARS = 1024;

type MintPreimageSegment =
  | { kind: 'literal'; text: string }
  | { kind: 'mediaBlob'; blobHash: string; base64Chars: number };

interface MintPreimageEnvelope {
  version: number;
  segments: MintPreimageSegment[];
}

interface InlineBase64Media {
  data: string;
  mediaType: string;
}

/**
 * A stored envelope exists but its bytes cannot be reproduced — a referenced
 * media blob is gone, the envelope is from an unknown version, or the spliced
 * result does not hash back to the key it was stored under. All three mean a
 * damaged store rather than an absent preimage, so they are loud: `null` from
 * the read APIs keeps its narrow meaning of "nothing was persisted here".
 */
export class MintPreimageMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintPreimageMaterializationError';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Every inline base64 media payload in the request, in the order
 * `JSON.stringify` emits them — membrane's `Base64Source` (image, document,
 * audio, video, including the ones nested inside tool results) and the
 * `generated_image` block, which carries its own base64 field.
 */
function collectInlineBase64Media(
  value: unknown,
  found: InlineBase64Media[] = [],
): InlineBase64Media[] {
  if (Array.isArray(value)) {
    for (const item of value) collectInlineBase64Media(item, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  const fields = value as Record<string, unknown>;
  if (fields.type === 'base64' && typeof fields.data === 'string' && typeof fields.mediaType === 'string') {
    found.push({ data: fields.data, mediaType: fields.mediaType });
    return found;
  }
  if (fields.type === 'generated_image' && typeof fields.data === 'string' && typeof fields.mimeType === 'string') {
    found.push({ data: fields.data, mediaType: fields.mimeType });
    return found;
  }
  for (const nested of Object.values(fields)) collectInlineBase64Media(nested, found);
  return found;
}

/**
 * The envelope for a request whose JSON text carries extractable media, or
 * null when there is none — in which case the caller stores the plain
 * preimage. Extraction is byte-conservative: a payload is only replaced when
 * base64 decode/re-encode reproduces the original characters exactly, so the
 * splice can never invent bytes the request did not have.
 */
function buildPreimageEnvelope(
  store: JsStore,
  requestJson: string,
  media: InlineBase64Media[],
): MintPreimageEnvelope | null {
  const segments: MintPreimageSegment[] = [];
  let cursor = 0;
  for (const { data, mediaType } of media) {
    if (data.length < MIN_EXTRACTED_BASE64_CHARS) continue;
    const decoded = Buffer.from(data, 'base64');
    if (decoded.toString('base64') !== data) continue;
    const at = requestJson.indexOf(data, cursor);
    if (at < 0) continue;
    const blobHash = store.storeBlob(decoded, mediaType);
    segments.push({ kind: 'literal', text: requestJson.slice(cursor, at) });
    segments.push({ kind: 'mediaBlob', blobHash, base64Chars: data.length });
    cursor = at + data.length;
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
    const base64 = blob.toString('base64');
    if (base64.length !== segment.base64Chars) return null;
    parts.push(Buffer.from(base64, 'utf8'));
  }
  return Buffer.concat(parts);
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
  const envelope = JSON.parse(bytes.toString('utf8')) as MintPreimageEnvelope;
  if (envelope.version !== MINT_PREIMAGE_ENVELOPE_VERSION) {
    throw new MintPreimageMaterializationError(
      `mint preimage envelope for ${requestHash} is version ${envelope.version}, ` +
        `this build reads version ${MINT_PREIMAGE_ENVELOPE_VERSION}`,
    );
  }
  return envelope;
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
    const media = collectInlineBase64Media(request);
    const envelope = media.length > 0 ? buildPreimageEnvelope(store, requestJson, media) : null;
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
  const materialized = materializeEnvelope(store, envelope);
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

/**
 * What a preimage costs this store, without materializing it: `inline` is the
 * plain whole-request blob (text-only mints), `envelope` is the media-bearing
 * form, where `storedBytes` counts ONLY the envelope — the media blobs it
 * names are the ones the messages themselves already put in the store, so
 * `blobHashes` is exactly the list of blobs this preimage shares rather than
 * copies. Answers "what is preimage persistence growing?" directly.
 */
export type StoredMintPreimage =
  | { form: 'absent' }
  | { form: 'inline'; storedBytes: number }
  | { form: 'envelope'; storedBytes: number; blobHashes: string[] };

export function describeStoredMintPreimage(
  store: JsStore,
  requestHash: string,
): StoredMintPreimage {
  const plain = store.getBlob(requestHash);
  if (plain !== null) return { form: 'inline', storedBytes: plain.length };
  const indexed = store.treeGet(MINT_PREIMAGE_ENVELOPE_INDEX_STATE_ID, requestHash);
  if (indexed === null) return { form: 'absent' };
  const envelope = readEnvelope(store, requestHash);
  if (envelope === null) return { form: 'absent' };
  return {
    form: 'envelope',
    storedBytes: indexed.size,
    blobHashes: envelope.segments
      .filter((segment): segment is Extract<MintPreimageSegment, { kind: 'mediaBlob' }> =>
        segment.kind === 'mediaBlob')
      .map((segment) => segment.blobHash),
  };
}
