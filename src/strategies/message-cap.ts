/**
 * The per-message token cap (`maxMessageTokens`) that the autobiographical
 * and windowed-passthrough strategies both apply. One truncator serves both,
 * so the markers it writes, and the combined recall answer's layout that
 * reads them back, can't drift apart. Each strategy passes its own estimate.
 */
import type { ContentBlock } from '@animalabs/membrane';
import { isEmptyTextBlock, releaseVanishedRawForms } from '../raw-forms.js';

/** A text block that holds nothing, the one rule the cap and the raw-form
 *  release share (raw-forms.ts). */
export { isEmptyTextBlock };

/** Written once in a message the cap cuts, so it doesn't read as ending at
 *  the cut: where the first dropped text block that held anything was, or,
 *  in the autobiographical strategy's combined recall answer with
 *  `recallEnvelope: 'xml'`, after its last answer when the cap left
 *  summaries out. It stands alone for content of text blocks that hold
 *  nothing when the cap leaves one of them out, and as that combined answer
 *  when the cap admits none of its summaries, so neither comes back empty or
 *  as whitespace alone. */
export const CAP_OMISSION_TEXT = '[content omitted: this message reached its token limit]';

/** The marker blocks capContent wrote, so a reader of its output can tell the
 *  truncator's own marker from a block whose text equals it, such as a block
 *  of a summary's prose, kept as itself or as the copy it becomes once it
 *  gives up its raw form. A marker carries no raw form, so none is copied
 *  there; the readers ask before the combined recall answer is wrapped in its
 *  envelope, which copies the blocks it rewrites. */
const capMarkers = new WeakSet<ContentBlock>();

function capMarker(): ContentBlock {
  const block: ContentBlock = { type: 'text', text: CAP_OMISSION_TEXT };
  capMarkers.add(block);
  return block;
}

/** Whether `block` is a marker capContent wrote, rather than a block whose
 *  text equals `CAP_OMISSION_TEXT`. */
export function isCapMarker(block: ContentBlock): boolean {
  return capMarkers.has(block);
}

/** Whether `capped`, what `capContent` made of `content`, lost nothing of it
 *  that holds anything: every block of `content` is in `capped` as it was,
 *  or is a text block that holds nothing, wherever the cap put it: kept as it
 *  was, kept as a copy that gave up a raw form, or left out across or past
 *  the cap. */
export function cappedWhole(content: readonly ContentBlock[], capped: readonly ContentBlock[]): boolean {
  if (capped === content) return true;
  const kept = new Set<ContentBlock>(capped);
  return content.every((block) => kept.has(block) || isEmptyTextBlock(block));
}

/**
 * Surrogate-safe string slice. Avoids cutting between a UTF-16 surrogate pair
 * which would produce invalid JSON ("no low surrogate in string" API errors).
 */
function safeSlice(str: string, start: number, end: number): string {
  if (end >= str.length) return str.slice(start);
  const code = str.charCodeAt(end);
  if (code >= 0xDC00 && code <= 0xDFFF) {
    return str.slice(start, end - 1);
  }
  return str.slice(start, end);
}

/**
 * Cut a message's text and string tool-result content to `maxTokens`, at four
 * characters a token, when `estimate(content)` is over it.
 *
 * - The text block that crosses the cap is cut, with a `[truncated — original
 *   was N tokens]` suffix.
 * - Text blocks past it are dropped. The first of them that holds anything
 *   becomes one `CAP_OMISSION_TEXT` block, where it was, so the message
 *   doesn't read as ending at the cut.
 * - A text block that holds nothing (`isEmptyTextBlock`) is kept as it is
 *   before the cap, while some of it remains (a block that fills the cap
 *   exactly ends it), spending its own length of it as any whole block does
 *   (none, for a text that isn't a string). Across the cap or past it, it's
 *   left out with no marker, since leaving it out loses nothing, as
 *   compression input drops one (`stripEmptyTextBlocks`). Across the cap,
 *   the cap ends there, as it does at a cut. So such a block is kept only
 *   while every block before it was kept, as it was or as a copy that gave
 *   up a raw form: the autobiographical strategy's combined recall answer
 *   reads this output back block by block on that rule. Content whose every
 *   block is such a text block comes back as one `CAP_OMISSION_TEXT` block
 *   when the cap leaves one of them out, so a message isn't emptied or left as
 *   whitespace alone, which the API refuses. Both strategies' estimates read
 *   every text block's `text.length` first, so content holding a text block
 *   whose text is missing or null throws in the estimate, before this walk.
 * - A string tool result keeps its pairing (the API requires a result for
 *   every tool use): cut with the same suffix, or past the cap given its own
 *   omission notice in place of its content. An empty one stays as it is,
 *   since it loses nothing.
 * - Every other block passes through.
 *
 * Returns `content` itself when every block survives unchanged, as when the
 * estimate passes the cap with nothing to cut: the autobiographical
 * strategy's estimate counts a thinking block, which the cut doesn't shorten,
 * and both strategies' estimates round each block up. A cut
 * or dropped block gives up its raw replay form, along with every block
 * sharing it, so the cut reaches the wire, except that a block that holds
 * nothing gives up its item's form only when no block left carries that item
 * (`releaseVanishedRawForms`). A `maxTokens` of 0 or less means no cap, as
 * `maxMessageTokens` does.
 */
export function capContent(
  content: ContentBlock[],
  maxTokens: number,
  estimate: (content: ContentBlock[]) => number,
): ContentBlock[] {
  if (maxTokens <= 0) return content;
  if (estimate(content) <= maxTokens) return content;

  const maxChars = maxTokens * 4;
  const result: ContentBlock[] = [];
  let remaining = maxChars;
  let markedOmission = false;

  for (const block of content) {
    if (block.type === 'text') {
      if (isEmptyTextBlock(block)) {
        const text = (block as { text?: unknown }).text;
        const length = typeof text === 'string' ? text.length : 0;
        if (remaining > 0 && length <= remaining) {
          result.push(block);
          remaining -= length;
        } else {
          remaining = 0;
        }
        continue;
      }
      if (remaining <= 0) {
        if (!markedOmission) {
          result.push(capMarker());
          markedOmission = true;
        }
        continue;
      }
      if (block.text.length <= remaining) {
        result.push(block);
        remaining -= block.text.length;
      } else {
        result.push({
          type: 'text',
          text: safeSlice(block.text, 0, remaining) + '\n\n[truncated — original was ' +
            Math.ceil(block.text.length / 4) + ' tokens]',
        });
        remaining = 0;
      }
    } else if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 0) {
      const text = block.content;
      if (remaining <= 0) {
        result.push({
          ...block,
          content: '[content omitted: this message reached its token limit before this result]',
        });
      } else if (text.length > remaining) {
        result.push({
          ...block,
          content: safeSlice(text, 0, remaining) + '\n\n[truncated — original was ' +
            Math.ceil(text.length / 4) + ' tokens]',
        });
        remaining = 0;
      } else {
        result.push(block);
        remaining -= text.length;
      }
    } else {
      result.push(block);
    }
  }

  if (result.length === content.length && result.every((block, i) => block === content[i])) return content;
  // Nothing left holds anything, and the cap left a block out: every other
  // block survives or leaves the marker, so every block was a text block
  // that holds nothing. The marker stands for the content.
  if (result.length < content.length && result.every(isEmptyTextBlock)) {
    return releaseVanishedRawForms(content, [capMarker()]);
  }
  return releaseVanishedRawForms(content, result);
}
