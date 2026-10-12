import type { JsStore } from '@animalabs/chronicle';
import type {
  ContentBlock,
  ImageContent,
  DocumentContent,
  AudioContent,
  VideoContent,
  Base64Source,
} from '@animalabs/membrane';
import type { BlobReference, StoredContentBlock } from './types/index.js';

/** Detect provider-supported raster image types from their byte signature.
 * Returns null for unknown/container types so callers can preserve the
 * declared MIME rather than guessing. */
function sniffRasterImageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
      Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function canonicalImageMediaTypeFromBase64(data: string, declared: string): string {
  // 32 base64 characters decode to 24 bytes, which cover every signature
  // above (the longest needs 12). Decode only a short prefix so legacy
  // multi-megabyte blobs do not get copied in full.
  const prefix = Buffer.from(data.slice(0, 32), 'base64');
  return sniffRasterImageMediaType(prefix) ?? declared;
}

/**
 * The blob a block is kept as, by its original type, or null for a block the
 * store keeps as given. Inline media becomes a blob: an image whose source
 * isn't a URL, and every document, audio or video block.
 */
function blobKindOf(block: ContentBlock): BlobReference['originalType'] | null {
  switch (block.type) {
    case 'image':
      return block.source.type === 'url' ? null : 'image';
    case 'document':
    case 'audio':
    case 'video':
      return block.type;
    default:
      return null;
  }
}

/**
 * The media type a blob is written under. Transport MIME is testimony, not
 * authority over the bytes: a wrong image label otherwise survives in the
 * BlobReference and causes permanent provider 400s every time the message is
 * rendered. Only raster formats with unambiguous signatures are relabeled;
 * any other type is kept as declared.
 */
function blobMediaType(bytes: Uint8Array, declared: string, kind: BlobReference['originalType']): string {
  return kind === 'image' ? sniffRasterImageMediaType(bytes) ?? declared : declared;
}

/** The block a blob reads back as, from its base64 data and its reference's media type. */
function blockFromBlob(kind: BlobReference['originalType'], data: string, mediaType: string): ContentBlock {
  const source: Base64Source = {
    type: 'base64',
    data,
    // Repair legacy references on read as well as new ingress on write.
    // This changes only the provider-facing MIME label, never blob bytes or
    // persisted source state.
    mediaType: kind === 'image' ? canonicalImageMediaTypeFromBase64(data, mediaType) : mediaType,
  };
  switch (kind) {
    case 'image':
      return { type: 'image', source } as ImageContent;
    case 'document':
      return { type: 'document', source } as DocumentContent;
    case 'audio':
      return { type: 'audio', source } as AudioContent;
    case 'video':
      return { type: 'video', source } as VideoContent;
    default:
      // A reference no release of this package writes: say so, rather than put
      // undefined into a message's content.
      throw new Error(`Blob reference of unknown original type: ${JSON.stringify(kind)}`);
  }
}

/**
 * A content block as the store hands it back once it is stored: what
 * `getMessage`, `getAllMessages` and `getMessageWindow` return for it with
 * blobs resolved (their default), live and after reopening. `append` and
 * `edit` return content as it was given, not this.
 *
 * Inline media is kept as a blob: an image whose source isn't a URL, and
 * every document, audio or video block. It comes back as
 * `{ type, source: { type: 'base64', data, mediaType } }` and nothing else:
 * its data is re-encoded from the decoded bytes, and an image's media type
 * is taken from its bytes' signature where they have one (png, jpeg, gif,
 * webp), any other type staying as declared. A URL image is kept as given,
 * like every other block, which comes back as it was given. This is built
 * from the same helpers as the store's own write and read, and no option
 * shapes that round trip: `resolveBlobs: false` only skips the read side, and
 * a blob reference never equals this.
 *
 * An image's stored form depends on this release's signature set: images are
 * relabelled on write and re-sniffed on read, so a release that recognized
 * another signature would read some stored images back under another type. A
 * digest of a stored form is a digest under the release that read it, and a
 * change to the signature set is a change to stored forms that its release
 * notes should say.
 *
 * The store's serialization applies to every block as well, and this doesn't
 * model it: what `JSON.stringify` changes changes here too. Undefined fields
 * are dropped, keys can come back in another order, NaN and Infinity become
 * null, -0 becomes 0, undefined array entries become null, and strings are
 * written as UTF-8, so a lone surrogate comes back as U+FFFD. Compare or hash
 * through a canonical serializer that normalizes these.
 *
 * This is the round trip of one block. A strategy's ingress chunking
 * (`chunkIngressMessage`) can store one delivered message as several, each
 * holding part of its content, which this doesn't predict.
 *
 * It throws for a block the store refuses on write, which has no stored form:
 * inline media whose data the store can't read as base64, or one without a
 * media type (for an image: none declared, and no recognized signature in its
 * bytes). It also throws for a `blob_ref`, which reads back as the media it
 * references, and that takes the store to know.
 *
 * Pure and synchronous: no store and no I/O, so a body can be hashed as the
 * store will keep it before anything is written.
 */
export function blockAsStored(block: ContentBlock): ContentBlock {
  if ((block as { type: string }).type === 'blob_ref') {
    throw new Error('blockAsStored: a blob_ref reads back as the media it references, which takes the store to know');
  }
  const kind = blobKindOf(block);
  if (!kind) return block;
  const { data, mediaType } = (block as { source: Base64Source }).source;
  // The store's own read of the data (storeBase64), so this refuses exactly what it refuses.
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    throw new Error(`blockAsStored: a ${kind} block whose data the store can't read as base64 has no stored form: the store refuses it`);
  }
  const storedType = blobMediaType(bytes, mediaType, kind);
  if (typeof storedType !== 'string') {
    throw new Error(`blockAsStored: a ${kind} block without a media type${kind === 'image' ? ' its bytes supply' : ''} has no stored form: the store refuses it`);
  }
  return blockFromBlob(kind, bytes.toString('base64'), storedType);
}

/**
 * Manages blob storage for media content.
 * Extracts base64 data from content blocks and stores them in Chronicle's blob storage.
 * Resolves blob references back to inline content on retrieval.
 */
export class BlobManager {
  constructor(private store: JsStore) {}

  /**
   * Content-addressed resolve cache (2026-07-18, sonn5 OOM class).
   *
   * Blobs are immutable and keyed by hash, so the two expensive parts of
   * resolution — the native `getBlob` buffer copy and the base64 encode —
   * are pure functions of the hash. Without this cache, every
   * `MessageStore.getAll()` re-fetched and re-encoded EVERY media blob in
   * history: on a 19.5k-message witness store with ~1.3G of blobs, each of
   * the ~6 full materializations per compile carried its own ~1.7G of
   * base64 strings (~12G transient, ~6.5G retained via chunk references)
   * → global OOM on a 22G box. JS strings are immutable and shared by
   * reference, so caching the encoded string collapses all copies onto
   * one allocation.
   *
   * LRU by insertion order (Map re-insert on hit), capped by decoded-ish
   * byte weight (string length ≈ bytes; base64 overhead makes this a
   * conservative overestimate of binary size). Override with
   * CONTEXT_MANAGER_BLOB_CACHE_BYTES; 0 disables.
   */
  private static readonly DEFAULT_RESOLVE_CACHE_BYTES = 3 * 1024 * 1024 * 1024;
  private readonly resolveCacheMaxBytes = (() => {
    const env = Number(process.env.CONTEXT_MANAGER_BLOB_CACHE_BYTES);
    return Number.isFinite(env) && env >= 0
      ? env
      : BlobManager.DEFAULT_RESOLVE_CACHE_BYTES;
  })();
  private resolveCache = new Map<string, string>();
  private resolveCacheBytes = 0;

  private cachedBlobBase64(hash: string): string | null {
    const hit = this.resolveCache.get(hash);
    if (hit !== undefined) {
      // LRU touch: re-insert so iteration order tracks recency.
      this.resolveCache.delete(hash);
      this.resolveCache.set(hash, hit);
      return hit;
    }
    const buffer = this.store.getBlob(hash);
    if (!buffer) return null;
    const data = buffer.toString('base64');
    if (this.resolveCacheMaxBytes > 0) {
      this.resolveCache.set(hash, data);
      this.resolveCacheBytes += data.length;
      while (
        this.resolveCacheBytes > this.resolveCacheMaxBytes &&
        this.resolveCache.size > 1
      ) {
        const oldest = this.resolveCache.keys().next().value as string;
        const evicted = this.resolveCache.get(oldest)!;
        this.resolveCache.delete(oldest);
        this.resolveCacheBytes -= evicted.length;
      }
    }
    return data;
  }

  /**
   * Extract blobs from content blocks and return references.
   * Replaces inline base64 data with blob references.
   */
  extractBlobs(content: ContentBlock[]): StoredContentBlock[] {
    return content.map((block) => this.extractBlobFromBlock(block));
  }

  /**
   * Resolve blob references back to inline content.
   */
  resolveBlobs(content: StoredContentBlock[]): ContentBlock[] {
    return content.map((block) => this.resolveBlobInBlock(block));
  }

  private extractBlobFromBlock(block: ContentBlock): StoredContentBlock {
    // Which blocks become blobs, and how they read back, is shared with
    // blockAsStored, so the store and that export can't disagree.
    const kind = blobKindOf(block);
    if (!kind) return block as StoredContentBlock;
    return { type: 'blob_ref', ref: this.storeBase64((block as { source: Base64Source }).source, kind) };
  }

  private storeBase64(
    source: Base64Source,
    originalType: BlobReference['originalType']
  ): BlobReference {
    const buffer = Buffer.from(source.data, 'base64');
    const mediaType = blobMediaType(buffer, source.mediaType, originalType);
    const hash = this.store.storeBlob(buffer, mediaType);

    return {
      hash,
      mediaType,
      originalType,
    };
  }

  private resolveBlobInBlock(block: StoredContentBlock): ContentBlock {
    if (block.type !== 'blob_ref') {
      return block as ContentBlock;
    }

    const { ref } = block;
    const data = this.cachedBlobBase64(ref.hash);

    if (data === null) {
      throw new Error(`Blob not found: ${ref.hash}`);
    }

    return blockFromBlob(ref.originalType, data, ref.mediaType);
  }

  /**
   * Check if a content block contains media that would be stored as a blob.
   */
  static hasStorableMedia(block: ContentBlock): boolean {
    return blobKindOf(block) !== null;
  }

  /**
   * Estimate the storage size of media content.
   */
  static estimateMediaSize(block: ContentBlock): number {
    if (!blobKindOf(block)) return 0;
    const data = (block as { source: { data?: unknown } }).source.data;
    return typeof data === 'string' ? Math.ceil(data.length * 0.75) : 0; // base64 -> bytes
  }
}
