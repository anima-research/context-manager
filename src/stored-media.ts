/**
 * Which blocks the store keeps as blobs, the media type a blob is written
 * under, and what of a source the store can't keep: one rule each, shared by
 * the store's write (blob-manager.ts) and the write boundary
 * (well-formed-content.ts), so the boundary refuses exactly what the store's
 * own write refuses.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { BlobReference } from './types/index.js';

/** Detect provider-supported raster image types from their byte signature.
 * Returns null for unknown/container types so callers can preserve the
 * declared MIME rather than guessing. */
export function sniffRasterImageMediaType(bytes: Uint8Array): string | null {
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

/** The raster image type base64 data's first bytes name, or null: what
 *  sniffRasterImageMediaType gives for the whole decode, with only a prefix
 *  decoded, so a multi-megabyte payload isn't copied in full. A prefix of a
 *  string decodes to the first bytes of the whole string's decode, and the
 *  longest signature needs 12 bytes, which 32 base64 characters cover with
 *  room to spare (24). The prefix doubles until it gives 12 bytes or is the
 *  whole string, for data whose first characters aren't base64, which the
 *  decode skips: only then does it decode more, and the prefixes it decodes
 *  add up to less than three times the string. */
export function imageMediaTypeOfBase64(data: string): string | null {
  let length = 32;
  let bytes = Buffer.from(data.slice(0, length), 'base64');
  while (bytes.length < 12 && length < data.length) {
    length *= 2;
    bytes = Buffer.from(data.slice(0, length), 'base64');
  }
  return sniffRasterImageMediaType(bytes);
}

/**
 * The blob a block is kept as, by its original type, or null for a block the
 * store keeps as given. Inline media becomes a blob: an image whose source
 * isn't a URL, and every document, audio or video block.
 */
export function blobKindOf(block: ContentBlock): BlobReference['originalType'] | null {
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
 * The media type the store writes a blob under: for an image, the type its
 * data's signature names (`sniff`, called for an image alone), else the
 * declared one; for other media, the declared one. Null when that isn't a
 * string: a blob the store can't keep. Transport MIME is testimony, not
 * authority over the bytes: a wrong image label otherwise survives in the
 * BlobReference and causes permanent provider 400s every time the message is
 * rendered. Only raster formats with unambiguous signatures are relabeled;
 * any other type is kept as declared.
 */
export function blobMediaType(
  kind: BlobReference['originalType'],
  declared: unknown,
  sniff: () => string | null,
): string | null {
  const sniffed = kind === 'image' ? sniff() : null;
  if (sniffed !== null) return sniffed;
  return typeof declared === 'string' ? declared : null;
}

/**
 * What the store can't keep of inline media's source, by its own write of it
 * (storeBase64), or null when it can keep the block: `data` when the store's
 * read of the data throws, and `mediaType` when its rule gives the blob no
 * media type (blobMediaType). A block the store keeps as given (blobKindOf)
 * has neither. Any string reads as base64, so string data is never refused,
 * and is decoded no further than the prefix an image's signature takes
 * (imageMediaTypeOfBase64). Data that isn't a string, outside membrane's
 * string type, is read as the store reads it (Buffer.from), which takes an
 * array of bytes, for one. Whether the store's read takes such data only
 * that read can say, so on that path alone the boundary copies the payload
 * once more than the store's write does.
 */
export function unstorableSource(block: ContentBlock): { data: boolean; mediaType: boolean } | null {
  const kind = blobKindOf(block);
  if (!kind) return null;
  const { data, mediaType } = (block as { source: { data?: unknown; mediaType?: unknown } }).source;
  let bytes: Uint8Array | null = null;
  if (typeof data !== 'string') {
    try {
      bytes = Buffer.from(data as string, 'base64');
    } catch {
      // No bytes for a signature: the blob's type is the declared one or none.
      return { data: true, mediaType: blobMediaType(kind, mediaType, () => null) === null };
    }
  }
  const type = blobMediaType(kind, mediaType, () =>
    typeof data === 'string' ? imageMediaTypeOfBase64(data) : sniffRasterImageMediaType(bytes!));
  return type === null ? { data: false, mediaType: true } : null;
}
