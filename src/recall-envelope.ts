import type { ContentBlock } from '@animalabs/membrane';
import type { RecallEnvelopeMode, SummaryEntry } from './types/strategy.js';

/**
 * Opt-in structural delimiting for the ANSWER side of a recall pair.
 *
 * A recall answer is model prose in the agent's own voice, and nothing in the
 * presented window marks where it stops: the Q-side label opens the memory and
 * the turn boundary is the only thing that closes it. Under
 * `recallEnvelope: 'xml'` each answer's prose is fenced by an XML-shaped tag
 * pair carrying the record's own identity, so a reader can see one memory end
 * before the next thing begins.
 *
 * The envelope is a collision-tolerant delimiter convention, not parseable XML:
 * answer content is passed through unescaped, so prose containing `<`, `&` or
 * even a literal `</cm-recall>` renders verbatim.
 *
 * Q-side labels are untouched in both modes — surgery keys on them.
 */
const RECALL_ENVELOPE_TAG = 'cm-recall';

export interface RecallEnvelopeTags {
  open: string;
  close: string;
}

/**
 * Build the tag pair for one summary. Every attribute is sourced from the
 * record: an attribute the record cannot answer for is OMITTED rather than
 * filled with a placeholder, so a present attribute is always a true one.
 */
export function buildRecallEnvelopeTags(summary: SummaryEntry): RecallEnvelopeTags {
  const attributes: string[] = [];
  if (summary.id) attributes.push(`id="${summary.id}"`);
  if (Number.isFinite(summary.level)) attributes.push(`level="${summary.level}"`);
  const first = summary.sourceRange?.first;
  const last = summary.sourceRange?.last;
  if (first && last) attributes.push(`span="${first}..${last}"`);
  const open = attributes.length > 0
    ? `<${RECALL_ENVELOPE_TAG} ${attributes.join(' ')}>`
    : `<${RECALL_ENVELOPE_TAG}>`;
  return { open, close: `</${RECALL_ENVELOPE_TAG}>` };
}

/**
 * The characters the envelope ADDS to an answer, or '' when it adds nothing.
 * Token accounting prices this string rather than a constant, so the figure
 * tracks the tag and its attributes instead of drifting from them.
 */
export function recallEnvelopeAddedText(
  summary: SummaryEntry,
  mode: RecallEnvelopeMode | undefined,
): string {
  if (mode !== 'xml') return '';
  const { open, close } = buildRecallEnvelopeTags(summary);
  return `${open}\n\n${close}`;
}

/**
 * Wrap a recall answer's content blocks.
 *
 * The tags land on the FIRST and LAST text blocks, never on reasoning
 * carriers: `responseContent` replays signed thinking whose signatures only
 * verify on byte-identical blocks, and a text block prepended before them
 * would also break the provider's thinking-first turn shape. Blocks that are
 * not rewritten are passed through by reference; rewritten ones are copies, so
 * the stored entry is never mutated.
 */
export function wrapRecallAnswerContent(
  content: ContentBlock[],
  summary: SummaryEntry,
  mode: RecallEnvelopeMode | undefined,
): ContentBlock[] {
  if (mode !== 'xml') return content;
  const { open, close } = buildRecallEnvelopeTags(summary);
  const textPositions: number[] = [];
  content.forEach((block, position) => {
    if (block.type === 'text') textPositions.push(position);
  });
  if (textPositions.length === 0) {
    // Carriers but no prose: still delimit the memory, still touch nothing.
    return [...content, { type: 'text', text: `${open}\n${close}` }];
  }
  const firstText = textPositions[0];
  const lastText = textPositions[textPositions.length - 1];
  return content.map((block, position) => {
    if (block.type !== 'text' || (position !== firstText && position !== lastText)) return block;
    const prefix = position === firstText ? `${open}\n` : '';
    const suffix = position === lastText ? `\n${close}` : '';
    return { ...block, text: `${prefix}${block.text}${suffix}` };
  });
}
