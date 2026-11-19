/**
 * The per-message token cap both strategies share (capContent): what it keeps,
 * what it drops, and where it says so. Strategy-level tests of the same marker
 * are in view-composition.test.ts, tool-pruning.test.ts,
 * fold-journal-autobiographical.test.ts, raw-forms.test.ts and
 * recall-envelope-truncation.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { capContent, cappedPriceExtra, cappedWhole, isCapMarker, isEmptyTextBlock } from '../src/strategies/message-cap.js';
import type { MessageStoreView, StoredMessage } from '../src/types/index.js';

/** Text and string tool results at four characters a token, as windowed passthrough counts. */
function textEstimate(content: ContentBlock[]): number {
  let tokens = 0;
  for (const block of content) {
    if (block.type === 'text') tokens += Math.ceil(block.text.length / 4);
    else if (block.type === 'tool_result' && typeof block.content === 'string') tokens += Math.ceil(block.content.length / 4);
  }
  return tokens;
}

/** Thinking too, as the autobiographical strategy counts. */
function withThinking(content: ContentBlock[]): number {
  let tokens = textEstimate(content);
  for (const block of content) if (block.type === 'thinking') tokens += Math.ceil(block.thinking.length / 4);
  return tokens;
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
// membrane's zero-width carrier for an opaque Responses item: its raw item is its whole content.
const opaqueCarrier = (): ContentBlock =>
  ({ type: 'text', text: '', rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'z' } } as ContentBlock);
const textOf = (block: ContentBlock | undefined): string | undefined => (block as { text?: string } | undefined)?.text;

describe('capContent', () => {
  it('returns the content itself when every block survives, though the estimate passed the cap', () => {
    const content = [{ type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock, text('short')];
    assert.ok(withThinking(content) > 100, 'premise: the estimate passes the cap');
    assert.equal(capContent(content, 100, withThinking), content);
  });

  it('writes one marker where the middle starts, and a tool result wholly in the middle says it is elided', () => {
    const out = capContent([
      text('x'.repeat(2000)),
      text('dropped'),
      { type: 'tool_result', toolUseId: 't1', content: 'the file' } as ContentBlock,
      text('y'.repeat(2000)),
    ], 100, textEstimate);
    assert.deepEqual(out.map((b) => b.type), ['text', 'text', 'tool_result', 'text']);
    assert.match(textOf(out[0])!, /^x+$/);
    assert.ok(isCapMarker(out[1]!));
    assert.equal((out[2] as { content: unknown }).content, '[truncated — this result is elided]', 'with no stored whole to name');
    assert.match(textOf(out[3])!, /^y+$/);
  });

  it('keeps an empty string tool result in the middle as it is, since it holds nothing to elide', () => {
    const empty = { type: 'tool_result', toolUseId: 't1', content: '' } as ContentBlock;
    const out = capContent([text('x'.repeat(2000)), empty, text('y'.repeat(2000))], 100, textEstimate);
    assert.ok(out.includes(empty));
  });

  it('drops an opaque carrier and an empty text block in the middle, and keeps a carrier at the end, in the tail', () => {
    const middle = opaqueCarrier();
    const out = capContent([text('x'.repeat(2000)), text(''), middle, text('y'.repeat(2000))], 100, textEstimate);
    assert.deepEqual(out.map(textOf).map((t) => t?.replace(/^(x|y)+$/, '$1…')), ['x…', textOf(out[1]), 'y…'], 'head, marker, tail');
    assert.ok(!out.includes(middle));

    const last = opaqueCarrier();
    const ending = capContent([text('x'.repeat(2000)), last], 100, textEstimate);
    assert.equal(ending.at(-1), last, 'the carrier at the end is in the tail');
  });

  it('leaves out blocks that hold nothing when that alone brings the text under the cap, with no marker, and keeps the rest as they were', () => {
    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const kept = text('a'.repeat(400));
    const content = [thinking, kept, text(' \n '), text('')];
    assert.ok(withThinking(content) > 100, 'premise: the estimate passes the cap');
    const out = capContent(content, 100, withThinking);
    assert.equal(out.length, 2, 'the text spends the cap exactly, and what follows holds nothing');
    assert.equal(out[0], thinking);
    assert.equal(out[1], kept);
  });

  it('keeps a block that holds nothing in the head as it is, and leaves one out when that alone brings the text under the cap', () => {
    const blank = text(' \n ');
    const out = capContent([blank, text('x'.repeat(2000))], 100, textEstimate);
    assert.equal(out[0], blank, 'in the head, kept as it was');
    assert.ok(isCapMarker(out[2]!), 'the long block is cut after it');

    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const kept = text('a'.repeat(397));
    // The blank block's own token, rounded up, takes the text one past the cap.
    assert.deepEqual(capContent([thinking, blank, kept], 100, withThinking), [thinking, kept]);
  });

  it('returns a message whose estimate is exactly the cap as it is, without walking it', () => {
    const content = [text('x'.repeat(400)), opaqueCarrier()];
    assert.equal(textEstimate(content), 100, 'premise: the estimate is exactly the cap');
    assert.equal(capContent(content, 100, textEstimate), content);
    const walked = capContent(content, 100, (c) => textEstimate(c) + 1);
    assert.ok(walked.some(isCapMarker), 'the premise: walked, it would be cut');
  });

  it('keeps an opaque carrier before the cap, though the estimate passed it', () => {
    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const content = [thinking, opaqueCarrier(), text('x'.repeat(400))];
    assert.ok(withThinking(content) > 100, 'premise: the estimate passes the cap, so the carrier is read');
    assert.equal(capContent(content, 100, withThinking), content, 'the carrier spends none of the cap, and the text spends it exactly');
  });

  it('brings content the cap leaves nothing of back as the marker alone, so a message is never emptied', () => {
    const out = capContent([text(' '.repeat(1000))], 100, textEstimate);
    assert.equal(out.length, 1);
    assert.ok(isCapMarker(out[0]!));
  });

  it('brings content of blank blocks back with the marker, so it is never whitespace alone', () => {
    const fits = text(' '.repeat(10));
    const out = capContent([fits, text(' '.repeat(1000))], 100, textEstimate);
    assert.equal(out[0], fits, 'the short blank block, in the head');
    assert.ok(isCapMarker(out[1]!), 'and the marker, where the long one was');
    assert.equal(out.length, 2);
  });

  it('leaves out a blank block at the end with no marker when the text before it fits', () => {
    // 'a' x 300 estimates at 75 tokens, and the blank block after it, 200 long, takes the text past 100.
    const out = capContent([text('a'.repeat(300)), text(' '.repeat(200))], 100, textEstimate);
    assert.deepEqual(out.map(textOf), ['a'.repeat(300)], 'the text as it was, and no marker: what was left out held nothing');
  });

  it('leaves out a blank block of any size when the rest fits, and cuts nothing else', () => {
    const a = text('a'.repeat(100));
    const b = text('b'.repeat(10));
    assert.deepEqual(capContent([a, text(' '.repeat(100_000)), b], 100, textEstimate), [a, b]);
  });

  it('leaves out a blank part of a Responses item when the rest fits, without giving up the item, which a kept part still carries', () => {
    const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'a'.repeat(400) }, { type: 'output_text', text: '  ' }] };
    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const part = { type: 'text', text: 'a'.repeat(400), rawItem: item } as ContentBlock;
    const out = capContent([thinking, part, { type: 'text', text: '  ', rawItem: item } as ContentBlock], 100, withThinking);
    assert.equal(out.length, 2, 'premise: the blank part is left out');
    assert.equal(out[1], part, 'the kept part keeps its item, since the item still ships whole through it');
  });

  it("returns the content itself for a cap that isn't a positive number, which means no cap, without estimating it", () => {
    // With no cap set, every raw message goes through here at every site
    // that prices it, so the estimate isn't taken.
    const content = [text('x'.repeat(2000)), text('dropped')];
    const unasked = (): number => { throw new Error('estimated content under no cap'); };
    assert.equal(capContent(content, 0, unasked), content);
    assert.equal(capContent(content, -1, unasked), content);
    assert.equal(capContent(content, Number.NaN, unasked), content);
    assert.equal(capContent(content, undefined as unknown as number, unasked), content);
  });

  it("reads a text block without string text as holding nothing, kept in the head, given an estimate that doesn't read its text", () => {
    const damaged = { type: 'text' } as unknown as ContentBlock;
    const lenient = (content: ContentBlock[]): number => content.reduce((tokens, block) => {
      const t = (block as { text?: unknown }).text;
      return tokens + (typeof t === 'string' ? Math.ceil(t.length / 4) : 0);
    }, 0);
    const out = capContent([damaged, text('x'.repeat(2000))], 100, lenient);
    assert.equal(out[0], damaged);
    assert.ok(isCapMarker(out[2]!), 'after it, the long block is cut');
  });
});

describe('cappedPriceExtra', () => {
  /** A store whose estimate counts its calls: a block's text length, plus 1 a block. */
  function countingStore(): { store: MessageStoreView; calls: () => number } {
    let calls = 0;
    const store = {
      estimateTokens: (message: StoredMessage) => {
        calls++;
        return message.content.reduce((sum, block) => sum + 1 + (textOf(block) ?? '').length, 0);
      },
    } as unknown as MessageStoreView;
    return { store, calls: () => calls };
  }

  it("is 0 for the message's own content, without estimating anything", () => {
    const { store, calls } = countingStore();
    const message = { content: [text('x'.repeat(40))] } as StoredMessage;
    assert.equal(cappedPriceExtra(store, message, message.content), 0);
    assert.equal(calls(), 0, 'no estimate taken for content the cap left whole');
  });

  it('is the estimate of what is sent less that of the message, for content the cap made', () => {
    const { store, calls } = countingStore();
    const message = { content: [text('x'.repeat(40))] } as StoredMessage;
    const capped = [text('x'.repeat(4)), text('[cut]')];
    assert.equal(cappedPriceExtra(store, message, capped), (5 + 6) - 41);
    assert.equal(calls(), 2);
  });
});

describe('cappedWhole', () => {
  it('is true when the cap left out only blocks that hold nothing, and false when it cut or dropped anything else', () => {
    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const blanks = [thinking, text('a'.repeat(400)), text('  ')];
    const left = capContent(blanks, 100, withThinking);
    assert.ok(left !== blanks && left.length === 2, 'premise: the cap left the blank block out');
    assert.equal(cappedWhole(blanks, left), true);
    const cut = [text('a'.repeat(2000))];
    assert.equal(cappedWhole(cut, capContent(cut, 100, textEstimate)), false);
    const dropped = [text('a'.repeat(400)), text('b')];
    assert.equal(cappedWhole(dropped, capContent(dropped, 100, textEstimate)), false);
    assert.equal(cappedWhole(blanks, blanks), true, 'and true for content the cap returned as it was');
  });
});

describe('isEmptyTextBlock', () => {
  it('is true only for text that holds nothing and carries no opaque item', () => {
    assert.equal(isEmptyTextBlock(text('')), true);
    assert.equal(isEmptyTextBlock(text(' \n\t ')), true, 'only whitespace holds nothing, as the strategy reads an empty summary');
    assert.equal(isEmptyTextBlock({ type: 'text' } as unknown as ContentBlock), true, 'a damaged block without text holds nothing, and doesn\'t throw');
    assert.equal(isEmptyTextBlock(text('a')), false);
    assert.equal(isEmptyTextBlock(text(' a ')), false);
    assert.equal(isEmptyTextBlock(opaqueCarrier()), false);
    assert.equal(isEmptyTextBlock({ type: 'thinking', thinking: '' } as ContentBlock), false);
  });
});
