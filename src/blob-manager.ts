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

/**
 * Manages blob storage for media content.
 * Extracts base64 data from content blocks and stores them in Chronicle's blob storage.
 * Resolves blob references back to inline content on retrieval.
 */
export class BlobManager {
  constructor(private store: JsStore) {}

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
    const hash = this.store.storeBlob(buffer, source.mediaType);

    return {
      hash,
      mediaType: source.mediaType,
      originalType,
    };
  }

  private resolveBlobInBlock(block: StoredContentBlock): ContentBlock {
    if (block.type !== 'blob_ref') {
      return block as ContentBlock;
    }

    const { ref } = block;
    const buffer = this.store.getBlob(ref.hash);

    if (!buffer) {
      throw new Error(`Blob not found: ${ref.hash}`);
    }

    const data = buffer.toString('base64');
    const source: Base64Source = {
      type: 'base64',
      data,
      mediaType: ref.mediaType,
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
