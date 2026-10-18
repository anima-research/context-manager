/**
 * The images a block list carries, as a provider receives them, and their
 * inline size. The live window's image strip (both strategies) and the
 * compression prompt's image cap count and strip with these, so the two
 * never disagree about what an image is or how large it is.
 */
import type { ContentBlock } from '@animalabs/membrane';
import { releaseEditedRawForms } from './raw-forms.js';

/**
 * True for a block a provider receives as an image: an `image` block, or a
 * `generated_image` (an image a model produced, which membrane sends back
 * as an image).
 */
export function isImageBlock(block: { type?: unknown }): boolean {
  return block.type === 'image' || block.type === 'generated_image';
}

/**
 * Inline payload characters of an image: a base64 source, a `data:` URL
 * source, or a `data` field beside `mimeType` (MCP image blocks in tool
 * results, generated images). 0 for a remote URL.
 */
export function inlineImageBytes(block: unknown): number {
  const image = block as { data?: unknown; source?: { data?: unknown; url?: unknown } };
  const src = image.source;
  if (typeof src?.data === 'string') return src.data.length;
  if (typeof src?.url === 'string' && src.url.slice(0, 5).toLowerCase() === 'data:') {
    const comma = src.url.indexOf(',');
    return comma < 0 ? src.url.length : src.url.length - comma - 1;
  }
  return typeof image.data === 'string' ? image.data.length : 0;
}

/** The content array a `tool_result` nests, if it nests one. */
function nestedContent(block: ContentBlock): ContentBlock[] | undefined {
  const content = (block as { type: string; content?: unknown }).content;
  return block.type === 'tool_result' && Array.isArray(content) ? content as ContentBlock[] : undefined;
}

/**
 * Every image the content carries, in the order a strip meets them: blocks
 * in order, and the images nested in a `tool_result` where that block sits.
 */
export function* imagesIn(content: readonly ContentBlock[]): Generator<ContentBlock> {
  for (const block of content) {
    if (isImageBlock(block)) {
      yield block;
      continue;
    }
    const nested = nestedContent(block);
    if (nested) yield* imagesIn(nested);
  }
}

/** True when the content carries an image, nested in a `tool_result` or not. */
export function hasImage(content: readonly ContentBlock[]): boolean {
  return !imagesIn(content).next().done;
}

/**
 * Replace images with a text placeholder, in the order `imagesIn` gives
 * them: `strip` is asked about each image once, and an image it answers
 * true for is replaced. Every raw form an edited block carried is
 * released, from the blocks that share it too (see raw-forms.ts), so a
 * replayed `rawXml` or `rawItem` can't carry an image the placeholder
 * replaced. A block is copied only when an image in it is replaced or it
 * gives up a raw form it shared with one; every other block keeps its
 * identity. Returns `content` itself when nothing was replaced.
 */
export function replaceImages(
  content: ContentBlock[],
  strip: (image: ContentBlock) => boolean,
  placeholder: string,
): ContentBlock[] {
  let changed = false;
  const next = content.map((block) => {
    if (isImageBlock(block)) {
      if (!strip(block)) return block;
      changed = true;
      return { type: 'text', text: placeholder } as ContentBlock;
    }
    const nested = nestedContent(block);
    if (!nested) return block;
    const inner = replaceImages(nested, strip, placeholder);
    if (inner === nested) return block;
    changed = true;
    return { ...block, content: inner } as ContentBlock;
  });
  return changed ? releaseEditedRawForms(content, next) : content;
}
