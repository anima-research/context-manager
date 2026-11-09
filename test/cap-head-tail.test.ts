/**
 * The per-message cap keeps a long message's head and tail, the head about
 * 60% of what it keeps and the tail 40%, around one marker that says which
 * characters it elided and where the whole is: the stored message or
 * summary by id, and, where the host supplies `capReadHint`, how to read it.
 * The cut finds the largest head and tail whose estimate, by the strategy's
 * own estimate the cap is given, fits the cap with the marker, and counts
 * no characters per token of its own. The characters it names are offsets
 * into the text it measures, `capMeasuredText`'s, so a reader paging from
 * the marker's first offset reads exactly the elided middle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { format } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, WindowedPassthroughStrategy } from '../src/index.js';
import type { ContextStrategy } from '../src/index.js';
import { capContent, isCapMarker } from '../src/strategies/message-cap.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const textOf = (block: ContentBlock | undefined): string | undefined => (block as { text?: string } | undefined)?.text;
const resultOf = (block: ContentBlock | undefined): string | undefined => (block as { content?: string } | undefined)?.content;

/** Text and string tool results, each block rounded up, as windowed passthrough counts them. */
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

/** Lines `zz-line-00000 …` of 30 characters each, `count` of them: 30 × count characters. */
const lines = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, i) => `zz-line-${String(from + i).padStart(5, '0')} ${'.'.repeat(15)}\n`).join('');

/** A text with no line break, `n` characters long, each position telling where it is. */
const unbroken = (n: number): string => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

const MARKER = /^\[truncated — chars (\d+) to (\d+) of (\d+) elided here(; the whole is stored (message|summary) (\S+?))?(; (.*))?\]$/;

function markerOf(t: string | undefined): { head: number; tailStart: number; total: number; kind?: string; id?: string; hint?: string } {
  const m = MARKER.exec(t ?? '');
  assert.ok(m, `a marker: ${JSON.stringify(t)}`);
  return { head: Number(m[1]), tailStart: Number(m[2]), total: Number(m[3]), kind: m[5], id: m[6], hint: m[8] };
}

describe('capContent keeps head and tail around one marker', () => {
  it('a 60,000-character message under a 10,000-token cap: its head, the marker naming the stored message, and its tail', () => {
    const whole = lines(2000);
    assert.equal(whole.length, 60_000, 'premise');
    const out = capContent([text(whole)], 10_000, textEstimate, { whole: { kind: 'message', id: 'm-1' } });
    assert.equal(out.length, 3, 'head, marker, tail');
    const marker = markerOf(textOf(out[1]));
    assert.ok(isCapMarker(out[1]!), 'the marker is told apart by identity');
    assert.equal(marker.total, 60_000);
    assert.deepEqual([marker.kind, marker.id], ['message', 'm-1']);
    assert.equal(textOf(out[0]), whole.slice(0, marker.head), 'the head is the text up to the first elided character');
    assert.equal(textOf(out[2]), whole.slice(marker.tailStart), 'the tail is the text from the first character after the middle');
    assert.ok(textOf(out[2])!.endsWith('zz-line-01999 ...............\n'), "the message's last line is kept");
    assert.ok(textEstimate(out) <= 10_000, `within the cap by the estimate: ${textEstimate(out)}`);
    assert.ok(textEstimate(out) >= 10_000 - 16, `and fills it to within a line at each end: ${textEstimate(out)}`);
  });

  it('splits what it keeps 60/40 between head and tail, where no line break moves either end', () => {
    const whole = unbroken(50_000);
    const out = capContent([text(whole)], 2_000, textEstimate);
    const marker = markerOf(textOf(out[1]));
    const head = marker.head;
    const tail = marker.total - marker.tailStart;
    assert.equal(head, Math.floor((head + tail) * 0.6), `head ${head}, tail ${tail}`);
    assert.equal(marker.kind, undefined, 'no stored whole was named, so the marker names none');
  });

  it("snaps the head's end and the tail's start to a line break within half their share", () => {
    const out = capContent([text(lines(2000))], 1_000, textEstimate);
    assert.ok(textOf(out[0])!.endsWith('\n'), 'the head ends at a line break');
    assert.match(textOf(out[2])!, /^zz-line-\d{5} /, 'the tail starts at a line');
  });

  it('moves neither end to a line break past half its share', () => {
    // One line break 100 characters into the text and one 100 from its end: each
    // is far more than half a share of about 2,400 or 1,600 characters from its cut.
    const whole = unbroken(100) + '\n' + unbroken(49_798) + '\n' + unbroken(100);
    const out = capContent([text(whole)], 1_000, textEstimate);
    const marker = markerOf(textOf(out[1]));
    const tail = marker.total - marker.tailStart;
    assert.equal(marker.head, Math.floor((marker.head + tail) * 0.6), `the 60/40 split stands: head ${marker.head}, tail ${tail}`);
  });

  for (const [name, estimate] of [
    ['three characters a token', (content: ContentBlock[]) => Math.ceil(textEstimate(content) * 4 / 3)],
    ['four characters a token times a calibration of 1.3', (content: ContentBlock[]) => Math.ceil(textEstimate(content) * 1.3)],
  ] as const) {
    it(`measures what it keeps by the estimate it's given, with no rate of its own: ${name}`, () => {
      const out = capContent([text(lines(2000))], 2_000, estimate);
      assert.equal(out.length, 3, 'head, marker, tail');
      assert.ok(estimate(out) <= 2_000, `within the cap by that estimate: ${estimate(out)}`);
      assert.ok(estimate(out) >= 2_000 - 22, `and fills it to within a line at each end: ${estimate(out)}`);
    });
  }

  it('never cuts inside a surrogate pair at either end', () => {
    const whole = '😀'.repeat(20_000);
    const out = capContent([text(whole)], 2_000, textEstimate);
    assert.equal(out.length, 3, 'premise: head, marker, tail');
    for (const t of [textOf(out[0])!, textOf(out[2])!]) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(t) && !/^[\uDC00-\uDFFF]/.test(t), 'no lone surrogate at a cut');
    }
  });

  it("drops text blocks wholly in the middle, cuts the two blocks the ends fall in, and passes every other block through in place", () => {
    const image = { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } } as ContentBlock;
    const thinking = { type: 'thinking', thinking: 'zz-thought', signature: 's' } as ContentBlock;
    const content = [text(lines(1000)), text('zz-middle-block'), image, thinking, text(lines(1000, 1000))];
    const out = capContent(content, 4_000, withThinking);
    assert.deepEqual(out.map((b) => b.type), ['text', 'text', 'image', 'thinking', 'text']);
    assert.ok(isCapMarker(out[1]!));
    assert.equal(out[2], image);
    assert.equal(out[3], thinking);
    assert.ok(!out.some((b) => textOf(b) === 'zz-middle-block'));
    const measured = lines(1000) + 'zz-middle-block' + lines(1000, 1000);
    const marker = markerOf(textOf(out[1]));
    assert.equal(marker.total, measured.length);
    assert.equal(textOf(out[0]) + measured.slice(marker.head, marker.tailStart) + textOf(out[4]), measured,
      'the elided characters are the measured text between the two offsets');
  });

  it('keeps a short last block after a long one whole, as part of the tail', () => {
    const last = text('zz-the-last-short-block');
    const out = capContent([text(lines(2000)), last], 2_000, textEstimate);
    assert.equal(out.at(-1), last);
  });

  it("doesn't shrink the text it keeps for a long thinking block, which it doesn't cut", () => {
    const thinking = { type: 'thinking', thinking: 'y'.repeat(100_000), signature: 's' } as ContentBlock;
    const out = capContent([thinking, text(lines(2000))], 2_000, withThinking);
    const kept = out.filter((b) => b.type === 'text');
    assert.ok(textEstimate(kept) >= 2_000 - 16, `the kept text and marker fill the cap to within a line at each end: ${textEstimate(kept)}`);
    assert.equal(out[0], thinking);
  });

  it('a cap the marker alone passes sends the marker alone', () => {
    const out = capContent([text(unbroken(10_000))], 5, textEstimate, { whole: { kind: 'message', id: 'm-1' } });
    assert.equal(out.length, 1);
    const marker = markerOf(textOf(out[0]));
    assert.deepEqual([marker.head, marker.tailStart, marker.total], [0, 10_000, 10_000]);
  });

  it('leaves out a block that holds nothing where an end falls in it, uncut, and the marker counts it as elided', () => {
    // The text past the cap without its blank block too, so the cut runs, and the
    // short block at one end leaves that end's share to fall in the blank block.
    const short = text(unbroken(1_000));
    const out = capContent([short, text(' '.repeat(40_000)), text(unbroken(5_000))], 1_000, textEstimate);
    assert.equal(out.length, 3, 'the short block, the marker and the long block\'s tail');
    assert.equal(out[0], short);
    const marker = markerOf(textOf(out[1]));
    assert.equal(marker.head, 1_000, 'the head ends where the blank block starts');
    assert.ok(marker.tailStart > 41_000, `the tail starts in the long block: ${marker.tailStart}`);

    const mirrored = capContent([text(unbroken(5_000)), text(' '.repeat(40_000)), short], 1_000, textEstimate);
    assert.equal(mirrored.length, 3, "the long block's head, the marker and the short block");
    assert.equal(mirrored[2], short);
    const mirroredMarker = markerOf(textOf(mirrored[1]));
    assert.equal(mirroredMarker.tailStart, 45_000, 'the tail starts where the blank block ends');
    assert.ok(mirroredMarker.head < 5_000, `the head ends in the long block: ${mirroredMarker.head}`);
  });

  it('leaves out its text blocks that hold nothing, and cuts nothing else, when that alone brings it under the cap', () => {
    const first = text(unbroken(1_000));
    const last = text(unbroken(1_000));
    assert.deepEqual(capContent([first, text(' '.repeat(40_000)), last], 1_000, textEstimate), [first, last]);
  });
});

describe('a string tool result keeps its pairing', () => {
  const result = (id: string, content: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content });

  it('one long result holds both ends: its head, the marker and its tail, in its own content', () => {
    const whole = lines(2000);
    const out = capContent([result('t1', whole)], 2_000, textEstimate, { whole: { kind: 'message', id: 'm-2' } });
    assert.equal(out.length, 1);
    assert.equal((out[0] as { toolUseId?: string }).toolUseId, 't1');
    const content = resultOf(out[0])!;
    const marker = /\[truncated — chars (\d+) to (\d+) of 60000 elided here; the whole is stored message m-2\]/.exec(content);
    assert.ok(marker, content.slice(0, 200));
    assert.equal(content, `${whole.slice(0, Number(marker[1]))}\n\n${marker[0]}\n\n${whole.slice(Number(marker[2]))}`,
      "exactly the head before the marker's first offset and the tail from its second");
    assert.ok(textEstimate(out) <= 2_000);
  });

  it('a result wholly in the middle says so in its content, and one the tail starts in says its start is elided, each naming the stored whole', () => {
    const out = capContent([result('t1', lines(1000)), result('t2', lines(300)), result('t3', lines(1000))], 2_000, textEstimate,
      { whole: { kind: 'message', id: 'm-3' } });
    assert.deepEqual(out.map((b) => (b as { toolUseId?: string }).toolUseId), ['t1', 't2', 't3'], 'every result keeps its pairing, in order');
    assert.match(resultOf(out[0])!, /\[truncated — chars \d+ to \d+ of 69000 elided here; the whole is stored message m-3\]$/, "the first result's head, then the marker");
    assert.equal(resultOf(out[1]), '[truncated — this result is elided; the whole is stored message m-3]',
      'a notice stands alone, since pairing repair can drop the result that holds the marker');
    assert.match(resultOf(out[2])!, /^\[truncated — this result's start is elided; the whole is stored message m-3\]\n\nzz-line-\d{5} /);
    assert.ok(resultOf(out[2])!.endsWith('zz-line-00999 ...............\n'));
    assert.ok(textEstimate(out) <= 2_000, `the notices count against the cap too: ${textEstimate(out)}`);
  });
});

describe('capReadHint', () => {
  it("ends the marker with the host's clause after `; `, built from the stored id and the first elided offset", () => {
    const calls: unknown[] = [];
    const hint = (at: { id: string; offsetChars?: number; toolUseId?: string }): string => {
      calls.push(at);
      return `read them with message_read {"id":"${at.id}","offsetChars":${at.offsetChars}}`;
    };
    const out = capContent([text(lines(2000))], 2_000, textEstimate, { whole: { kind: 'message', id: 'm-3' }, hint });
    const marker = markerOf(textOf(out[1]));
    assert.equal(marker.hint, `read them with message_read {"id":"m-3","offsetChars":${marker.head}}`);
    assert.ok(calls.some((at) => JSON.stringify(at) === JSON.stringify({ id: 'm-3', offsetChars: marker.head })));
    assert.ok(textEstimate(out) <= 2_000, 'the hint is inside the cap');
  });
});

const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };

async function withManager(strategy: ContextStrategy, run: (manager: ContextManager) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'zz-cap-head-tail-'));
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const hint = (at: { id: string; offsetChars?: number; toolUseId?: string }): string =>
  `read them with message_read ${JSON.stringify(at)}`;

const STRATEGIES: Record<string, (cap: number) => ContextStrategy> = {
  autobiographical: (cap) => new AutobiographicalStrategy({
    headWindowTokens: 0, recentWindowTokens: 1_000_000, maxMessageTokens: cap, capReadHint: hint,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
  'windowed passthrough': (cap) => new WindowedPassthroughStrategy({
    imageStripDepthTokens: 0, maxMessageTokens: cap, capReadHint: hint,
  } as ConstructorParameters<typeof WindowedPassthroughStrategy>[0]),
};

describe('a compile sends a capped message as its head, the marker naming it and the hint, and its tail', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: and paging the stored text from the marker's first offset reads exactly the elided characters`, async () => {
      await withManager(make(10_000), async (cm) => {
        const whole = lines(2000);
        const id = cm.addMessage('user', [text(whole)]);
        const compiled = await cm.compile(BUDGET);
        const content = compiled.messages.at(-1)!.content as ContentBlock[];
        assert.equal(content.length, 3, 'head, marker, tail');
        const marker = markerOf(textOf(content[1]));
        assert.deepEqual([marker.kind, marker.id], ['message', id]);
        assert.equal(marker.hint, `read them with message_read ${JSON.stringify({ id, offsetChars: marker.head })}`);
        const measured = cm.capMeasuredText({ id })!;
        assert.equal(measured, whole);
        assert.equal(textOf(content[0]) + measured.slice(marker.head, marker.tailStart) + textOf(content[2]), whole);
        const again = await cm.compile(BUDGET);
        assert.deepEqual(again.messages.at(-1)!.content, compiled.messages.at(-1)!.content, 'a pure hint gives the same bytes at every compile');
      });
    });
  }
});

describe('a call input over toolUseInputMaxTokens names where its whole is', () => {
  it("the stub keeps its fields and gains `_whole`, naming the stored message, the call and the hint", async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0, recentWindowTokens: 1_000_000, toolUseInputMaxTokens: 10, capReadHint: hint,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    await withManager(strategy, async (cm) => {
      const input = { path: '/notes.md', text: 'zz-' + 'w'.repeat(500) };
      const id = cm.addMessage('Claude', [{ type: 'tool_use', id: 't9', name: 'fs:write', input } as ContentBlock]);
      cm.addMessage('user', [{ type: 'tool_result', toolUseId: 't9', content: 'ok' } as ContentBlock]);
      const compiled = await cm.compile(BUDGET);
      const call = compiled.messages.flatMap((m) => m.content as ContentBlock[]).find((b) => b.type === 'tool_use') as { input: Record<string, unknown> };
      const chars = JSON.stringify(input).length;
      assert.deepEqual(call.input, {
        _truncated: true,
        _originalTokens: (call.input as { _originalTokens: number })._originalTokens,
        _keys: ['path', 'text'],
        _whole: `[truncated — this call's input, ${chars} chars, is elided; the whole is stored message ${id}, call t9; ` +
          `read them with message_read ${JSON.stringify({ id, toolUseId: 't9' })}]`,
      });
      assert.equal(cm.capMeasuredText({ id, toolUseId: 't9' }), JSON.stringify(input), 'the reader pages the input whole');
    });
  });
});

describe('the cut is never longer than the whole', () => {
  it('a message over the cap that its marker alone would outgrow is sent whole', () => {
    const content = [text('x'.repeat(40))];
    assert.ok(textEstimate(content) > 1, 'premise: over the cap');
    const alone = capContent([text(unbroken(10_000))], 1, textEstimate, { whole: { kind: 'message', id: 'm-1' } });
    assert.ok(alone.length === 1 && textEstimate(alone) > textEstimate(content), 'premise: the marker alone is longer than this message');
    assert.equal(capContent(content, 1, textEstimate, { whole: { kind: 'message', id: 'm-1' } }), content);
  });

  it('sends the whole, too, where the marker alone would estimate exactly as much, since the whole loses nothing', () => {
    const perBlock = (blocks: ContentBlock[]): number => blocks.length * 10;
    const content = [text('x'.repeat(4_000))];
    assert.equal(capContent(content, 5, perBlock), content, 'the whole and the marker alone each estimate at 10, over the cap of 5');
  });

  it('a call input whose stub would be no shorter than it is sent whole', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0, recentWindowTokens: 1_000_000, toolUseInputMaxTokens: 10,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    await withManager(strategy, async (cm) => {
      const input = { path: '/a', text: 'zz-' + 'w'.repeat(40) };
      assert.ok(JSON.stringify(input).length > 40, 'premise: over the 10-token cap at four characters a token');
      cm.addMessage('Claude', [{ type: 'tool_use', id: 't8', name: 'fs:write', input } as ContentBlock]);
      cm.addMessage('user', [{ type: 'tool_result', toolUseId: 't8', content: 'ok' } as ContentBlock]);
      const compiled = await cm.compile(BUDGET);
      const call = compiled.messages.flatMap((m) => m.content as ContentBlock[]).find((b) => b.type === 'tool_use') as { input: Record<string, unknown> };
      assert.deepEqual(call.input, input);
    });
  });
});

/** The lines console.warn gets while `body` runs, formatted as console formats them. */
async function warned(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const { warn } = console;
  console.warn = (...args: unknown[]) => { lines.push(format(...args)); };
  try {
    await body();
  } finally {
    console.warn = warn;
  }
  return lines;
}

const throwingHint = (): string => { throw new Error('zz-hint-down'); };

describe('a capReadHint that throws', () => {
  const makers: Record<string, () => ContextStrategy> = {
    autobiographical: () => new AutobiographicalStrategy({
      headWindowTokens: 0, recentWindowTokens: 1_000_000, maxMessageTokens: 10_000, toolUseInputMaxTokens: 10, capReadHint: throwingHint,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
    'windowed passthrough': () => new WindowedPassthroughStrategy({
      imageStripDepthTokens: 0, maxMessageTokens: 10_000, capReadHint: throwingHint,
    } as ConstructorParameters<typeof WindowedPassthroughStrategy>[0]),
  };
  for (const [name, make] of Object.entries(makers)) {
    it(`${name}: fails no compile; the marker names the stored message by id alone, and the throw is said once`, async () => {
      const said = await warned(() => withManager(make(), async (cm) => {
        const id = cm.addMessage('user', [text(lines(2000))]);
        for (let i = 0; i < 2; i++) {
          const compiled = await cm.compile(BUDGET);
          const content = compiled.messages.at(-1)!.content as ContentBlock[];
          const marker = markerOf(textOf(content[1]));
          assert.deepEqual([marker.kind, marker.id, marker.hint], ['message', id, undefined]);
        }
      }));
      assert.equal(said.filter((line) => line.includes('capReadHint')).length, 1, `said once: ${JSON.stringify(said)}`);
      assert.ok(said.some((line) => line.includes('zz-hint-down')), 'with what it threw');
    });
  }

  it('fails no compile where the logger it says the throw to throws too', async () => {
    const { warn } = console;
    let tried = 0;
    console.warn = () => { tried += 1; throw new Error('zz-logger-down'); };
    try {
      await withManager(makers['windowed passthrough']!(), async (cm) => {
        const id = cm.addMessage('user', [text(lines(2000))]);
        const compiled = await cm.compile(BUDGET);
        const marker = markerOf(textOf((compiled.messages.at(-1)!.content as ContentBlock[])[1]));
        assert.deepEqual([marker.kind, marker.id, marker.hint], ['message', id, undefined]);
      });
    } finally {
      console.warn = warn;
    }
    assert.ok(tried >= 1, 'premise: the strategy tried to say the throw');
  });

  it("autobiographical: a call input's `_whole` names the message and the call alone", async () => {
    await withManager(makers.autobiographical!(), async (cm) => {
      const input = { path: '/notes.md', text: 'zz-' + 'w'.repeat(500) };
      const id = cm.addMessage('Claude', [{ type: 'tool_use', id: 't9', name: 'fs:write', input } as ContentBlock]);
      cm.addMessage('user', [{ type: 'tool_result', toolUseId: 't9', content: 'ok' } as ContentBlock]);
      const said = await warned(async () => {
        const compiled = await cm.compile(BUDGET);
        const call = compiled.messages.flatMap((m) => m.content as ContentBlock[]).find((b) => b.type === 'tool_use') as { input: { _whole?: string } };
        assert.equal(call.input._whole, `[truncated — this call's input, ${JSON.stringify(input).length} chars, is elided; the whole is stored message ${id}, call t9]`);
      });
      assert.ok(said.length <= 1);
    });
  });
});
