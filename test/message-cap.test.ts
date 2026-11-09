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
import { CAP_OMISSION_TEXT, capContent, cappedPriceExtra, cappedWhole, isEmptyTextBlock } from '../src/strategies/message-cap.js';
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

  it('writes the marker where the first dropped text block was, before a later tool result', () => {
    const out = capContent([
      text('x'.repeat(2000)),
      text('dropped'),
      { type: 'tool_result', toolUseId: 't1', content: 'the file' } as ContentBlock,
      text('also dropped'),
    ], 100, textEstimate);
    assert.deepEqual(out.map((b) => b.type), ['text', 'text', 'tool_result']);
    assert.match(textOf(out[0])!, /\[truncated — original was 500 tokens\]$/);
    assert.equal(textOf(out[1]), CAP_OMISSION_TEXT);
    assert.equal(
      (out[2] as { content: unknown }).content,
      '[content omitted: this message reached its token limit before this result]',
    );
  });

  it('keeps an empty string tool result past the cap as it is', () => {
    const empty = { type: 'tool_result', toolUseId: 't1', content: '' } as ContentBlock;
    const out = capContent([text('x'.repeat(2000)), empty], 100, textEstimate);
    assert.equal(out.length, 2);
    assert.equal(out[1], empty);
  });

  it('marks an opaque carrier past the cap, which holds an item, and leaves out an empty text block before it', () => {
    const out = capContent([text('x'.repeat(2000)), text(''), opaqueCarrier()], 100, textEstimate);
    assert.equal(out.length, 2, 'the cut block and one marker');
    assert.match(textOf(out[0])!, /\[truncated — original was 500 tokens\]$/);
    assert.equal(textOf(out[1]), CAP_OMISSION_TEXT);

    const control = capContent([text('x'.repeat(2000)), text('')], 100, textEstimate);
    assert.equal(control.length, 1, 'an empty text block alone past the cap is left out, and nothing marks it');
  });

  it('leaves out blocks that hold nothing past the cap, with no marker, and keeps the rest as they were', () => {
    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const kept = text('a'.repeat(400));
    const content = [thinking, kept, text(' \n '), text('')];
    assert.ok(withThinking(content) > 100, 'premise: the estimate passes the cap');
    const out = capContent(content, 100, withThinking);
    assert.equal(out.length, 2, 'the text spends the cap exactly, and what follows holds nothing');
    assert.equal(out[0], thinking);
    assert.equal(out[1], kept);
  });

  it('keeps a block that holds nothing before the cap as it is, spending its own length of the cap', () => {
    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const blank = text(' \n ');
    const content = [thinking, blank, text('a'.repeat(397))];
    assert.ok(withThinking(content) > 100, 'premise: the estimate passes the cap');
    assert.equal(capContent(content, 100, withThinking), content, 'the blank block spends 3 of the 400 characters, and the text the rest');
    const over = capContent([thinking, blank, text('a'.repeat(398))], 100, withThinking);
    assert.equal(over[1], blank);
    assert.match(textOf(over[2])!, /^a{397}\n\n\[truncated/, 'a text one character longer is cut where the blank block left the cap');
  });

  it('returns a message whose estimate is exactly the cap as it is, without walking it: an opaque carrier after text that spends the cap stays', () => {
    const content = [text('x'.repeat(400)), opaqueCarrier()];
    assert.equal(textEstimate(content), 100, 'premise: the estimate is exactly the cap');
    assert.equal(capContent(content, 100, textEstimate), content);
    const walked = capContent(content, 100, (c) => textEstimate(c) + 1);
    assert.equal(textOf(walked.at(-1)), CAP_OMISSION_TEXT, 'the premise: walked, the carrier past the cap would be marked');
  });

  it('keeps an opaque carrier before the cap, though the estimate passed it', () => {
    const thinking = { type: 'thinking', thinking: 'y'.repeat(2000) } as ContentBlock;
    const content = [thinking, opaqueCarrier(), text('x'.repeat(400))];
    assert.ok(withThinking(content) > 100, 'premise: the estimate passes the cap, so the carrier is read');
    assert.equal(capContent(content, 100, withThinking), content, 'the carrier spends none of the cap, and the text spends it exactly');
  });

  it('leaves out a block that holds nothing across the cap, uncut, and the cap ends there', () => {
    // 399 characters leave one of the cap's 400 for the blank block, which is two long.
    const out = capContent([text('a'.repeat(399)), text('\n\n'), text('b')], 100, textEstimate);
    assert.deepEqual(out.map(textOf), ['a'.repeat(399), CAP_OMISSION_TEXT], 'the next block that holds anything is past the cap, and marked');
  });

  it('brings content the cap leaves nothing of back as the marker alone, so a message is never emptied', () => {
    assert.deepEqual(capContent([text(' '.repeat(1000))], 100, textEstimate).map(textOf), [CAP_OMISSION_TEXT]);
    assert.deepEqual(capContent([text('\n'.repeat(500)), text(' '.repeat(10))], 100, textEstimate).map(textOf), [CAP_OMISSION_TEXT]);
  });

  it('brings content of blank blocks back as the marker alone when one fits and a later one crosses the cap, so it is not whitespace alone', () => {
    const fits = text(' '.repeat(10));
    assert.deepEqual(capContent([fits, text(' '.repeat(1000))], 100, textEstimate).map(textOf), [CAP_OMISSION_TEXT]);
  });

  it('leaves out a blank block that crosses the cap with no marker when nothing after it holds anything', () => {
    // 'a' x 300 leaves 100 of the cap's 400 characters, and the blank block after it is 200 long.
    const out = capContent([text('a'.repeat(300)), text(' '.repeat(200))], 100, textEstimate);
    assert.deepEqual(out.map(textOf), ['a'.repeat(300)], 'the text as it was, and no marker: what was left out held nothing');
  });

  it('leaves out a blank block of any size across the cap', () => {
    const out = capContent([text('a'.repeat(100)), text(' '.repeat(100_000)), text('b'.repeat(10))], 100, textEstimate);
    assert.deepEqual(out.map(textOf), ['a'.repeat(100), CAP_OMISSION_TEXT]);
  });

  it('leaves out a blank part of a Responses item past the cap without giving up the item, which a kept part still carries', () => {
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

  it("reads a text block without string text as holding nothing, so, given an estimate that doesn't read its text, it passes before the cap", () => {
    const damaged = { type: 'text' } as unknown as ContentBlock;
    const out = capContent([damaged, text('x'.repeat(2000))], 100, () => 1000);
    assert.equal(out[0], damaged);
    assert.match(textOf(out[1])!, /\[truncated — original was 500 tokens\]$/);
  });

  it('never cuts inside a surrogate pair', () => {
    // The cap buys 4 characters, and the emoji's two code units sit at 3 and 4.
    const out = capContent([text('aaa\u{1F600}' + 'b'.repeat(20))], 1, textEstimate);
    const cut = textOf(out[0])!;
    assert.ok(cut.startsWith('aaa\n\n[truncated'), cut);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), 'no lone high surrogate');
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
