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
 * the SAME digest `sha256Json` computes for `requestHash` — so a preimage
 * written here is retrievable under the hash the summary already carries,
 * deduplicated across retries for free, and durable in the same store the
 * summary itself persists to.
 */
const MINT_REQUEST_PREIMAGE_CONTENT_TYPE = 'application/json';

/**
 * Store the exact bytes `requestHash` was computed over, keyed by that hash.
 *
 * Never throws. A memory outranks its receipt: a store that refuses the blob
 * (disk full, closed store) must not lose the summary the LLM just paid for,
 * so failures are loud on stderr and non-fatal — the same stance
 * `logCompressionCall` takes. A hash mismatch means the request object
 * mutated between hashing and persistence; the blob is still written (under
 * its true key) and the divergence is reported rather than papered over.
 */
export function persistMintRequestPreimage(
  store: JsStore,
  request: NormalizedRequest,
  requestHash: string,
): void {
  try {
    const preimage = Buffer.from(JSON.stringify(request), 'utf8');
    const storedHash = store.storeBlob(preimage, MINT_REQUEST_PREIMAGE_CONTENT_TYPE);
    if (storedHash !== requestHash) {
      console.error(
        `[mint-preimage] preimage stored under ${storedHash} but provenance keys ${requestHash} — ` +
          'the authoring request changed between hashing and persistence; the preimage is readable ' +
          'under the STORED key only',
      );
    }
  } catch (error) {
    console.error(`[mint-preimage] failed to persist request preimage ${requestHash}:`, error);
  }
}

/**
 * Raw preimage bytes for a `provenance.requestHash`, or null when the mint
 * predates this module / was minted with `persistMintPreimages: false`.
 *
 * Verify with `createHash('sha256').update(bytes).digest('hex') === requestHash`:
 * the store keys blobs by that digest, so a returned buffer IS the request
 * the summary was authored from, not a reconstruction.
 */
export function getMintRequestPreimageBytes(
  store: JsStore,
  requestHash: string,
): Buffer | null {
  return store.getBlob(requestHash);
}

/**
 * The authoring request behind a `provenance.requestHash`, parsed, or null
 * when no preimage was persisted for it.
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
