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
  // The first 16 decoded bytes cover every signature above. Decode only a
  // short prefix so legacy multi-megabyte blobs do not get copied in full.
  const prefix = Buffer.from(data.slice(0, 32), 'base64');
  return sniffRasterImageMediaType(prefix) ?? declared;
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
    switch (block.type) {
      case 'image':
        return this.extractFromImage(block);
      case 'document':
        return this.extractFromDocument(block);
      case 'audio':
        return this.extractFromAudio(block);
      case 'video':
        return this.extractFromVideo(block);
      default:
        // Other block types pass through unchanged
        return block as StoredContentBlock;
    }
  }

  private extractFromImage(block: ImageContent): StoredContentBlock {
    if (block.source.type === 'url') {
      // URL sources don't need blob storage - pass through unchanged
      return block;
    }

    const ref = this.storeBase64(block.source, 'image');
    return { type: 'blob_ref', ref };
  }

  private extractFromDocument(block: DocumentContent): StoredContentBlock {
    const ref = this.storeBase64(block.source, 'document');
    return { type: 'blob_ref', ref };
  }

  private extractFromAudio(block: AudioContent): StoredContentBlock {
    const ref = this.storeBase64(block.source, 'audio');
    return { type: 'blob_ref', ref };
  }

  private extractFromVideo(block: VideoContent): StoredContentBlock {
    const ref = this.storeBase64(block.source, 'video');
    return { type: 'blob_ref', ref };
  }

  private storeBase64(
    source: Base64Source,
    originalType: BlobReference['originalType']
  ): BlobReference {
    const buffer = Buffer.from(source.data, 'base64');
    // Transport MIME is testimony, not authority over the bytes. A wrong
    // image label otherwise survives in BlobReference and causes permanent
    // provider 400s every time the message is rendered. Canonicalize only
    // raster formats with unambiguous signatures; preserve unknown types.
    const mediaType = originalType === 'image'
      ? sniffRasterImageMediaType(buffer) ?? source.mediaType
      : source.mediaType;
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

    const source: Base64Source = {
      type: 'base64',
      data,
      // Repair legacy references on read as well as new ingress on write.
      // This changes only the provider-facing MIME label, never blob bytes or
      // persisted source state.
      mediaType: ref.originalType === 'image'
        ? canonicalImageMediaTypeFromBase64(data, ref.mediaType)
        : ref.mediaType,
    };

    switch (ref.originalType) {
      case 'image':
        return { type: 'image', source } as ImageContent;
      case 'document':
        return { type: 'document', source } as DocumentContent;
      case 'audio':
        return { type: 'audio', source } as AudioContent;
      case 'video':
        return { type: 'video', source } as VideoContent;
    }
  }

  /**
   * Check if a content block contains media that would be stored as a blob.
   */
  static hasStorableMedia(block: ContentBlock): boolean {
    switch (block.type) {
      case 'image':
        return block.source.type === 'base64';
      case 'document':
      case 'audio':
      case 'video':
        return true;
      default:
        return false;
    }
  }

  /**
   * Estimate the storage size of media content.
   */
  static estimateMediaSize(block: ContentBlock): number {
    switch (block.type) {
      case 'image':
        if (block.source.type === 'base64') {
          return Math.ceil(block.source.data.length * 0.75); // base64 -> bytes
        }
        return 0;
      case 'document':
      case 'audio':
      case 'video':
        return Math.ceil(block.source.data.length * 0.75);
      default:
        return 0;
    }
  }
}
