/**
 * Serialized-media projection, asserted on the WIRE (#115 review): capture the
 * requests the summarizer actually receives, for every compression path, and
 * check Chronicle is untouched. The helper-only tests could not see that the L1
 * strip was applied to a copy the request never shipped.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'serialized-media-wire-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const MARKER = 'omitted from compression prompt';
const TOOLS = [{ name: 'fn', description: 'test tool', inputSchema: { type: 'object' as const } }];

function recorder(refuseFirst = 0) {
  const requests: string[] = [];
  let calls = 0;
  const membrane = {
    complete: async (req: unknown) => {
      requests.push(JSON.stringify(req));
      calls++;
      if (calls <= refuseFirst) return { stopReason: 'refusal', content: [], usage: { inputTokens: 10, outputTokens: 0 } };
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}.` }], usage: { inputTokens: 500, outputTokens: 50 } };
    },
  };
  return { membrane, requests };
}

async function run(name: string, config: Record<string, unknown>, seed: (cm: ContextManager) => void, refuseFirst = 0) {
  const { membrane, requests } = recorder(refuseFirst);
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, summaryParticipant: 'Claude', hierarchical: true,
    mergeThreshold: 1000, ...config,
  });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: membrane as never });
  cm.setToolDefinitions(TOOLS);
  seed(cm);
  for (let i = 0; i < 40; i++) { await cm.compile(); await cm.tick(); }
  return { cm, requests };
}

const filler = (i: number) => `M-${i} ${'word '.repeat(30)}`;

describe('serialized media on the wire', () => {
  it('L1 canonical request: the payload never ships, Chronicle keeps it', async () => {
    const payload = 'Q'.repeat(20_000);
    let id = '';
    const { cm, requests } = await run('l1', {}, (cm) => {
      id = cm.addMessage('User', [{ type: 'text', text: `look: data:image/png;base64,${payload}` }]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    });
    assert.ok(requests.length > 0);
    assert.equal(requests.filter((r) => r.includes(payload)).length, 0, 'payload on the wire');
    assert.ok(requests.some((r) => r.includes(MARKER)), 'marker on the wire');
    const stored = JSON.stringify((cm as unknown as { messageStore: { get(id: string): unknown } }).messageStore.get(id));
    assert.ok(stored.includes(payload), 'Chronicle message unchanged');
    cm.close();
  });

  it('string-form tool_result content is projected too', async () => {
    const payload = 'S'.repeat(20_000);
    const { cm, requests } = await run('string-tool-result', {}, (cm) => {
      cm.addMessage('Claude', [{ type: 'tool_use', id: 't1', name: 'fn', input: {} } as ContentBlock]);
      cm.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: JSON.stringify({ image_url: `data:image/png;base64,${payload}` }) } as ContentBlock]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    });
    assert.ok(requests.length > 0);
    assert.equal(requests.filter((r) => r.includes(payload)).length, 0, 'payload on the wire');
    assert.ok(requests.some((r) => r.includes(MARKER)));
    cm.close();
  });

  it('merge requests are projected', async () => {
    const payload = 'R'.repeat(20_000);
    const { cm, requests } = await run('merge', { mergeThreshold: 3 }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: `see data:image/png;base64,${payload}` }]);
      for (let i = 0; i < 60; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    });
    // Merge prompts end with "…consolidate into a single L2 memory". A merge
    // expands its L1 sources to their raw messages, so the media message is replayed.
    const merges = requests.filter((r) => r.includes('into a single L2 memory'));
    assert.ok(merges.length > 0, 'at least one L2 merge ran');
    const replaying = merges.filter((r) => r.includes('see [embedded image/png'));
    assert.ok(replaying.length > 0, 'a merge replayed the media message, projected');
    assert.equal(merges.filter((r) => r.includes(payload)).length, 0, 'payload in a merge request');
    cm.close();
  });

  it('the L1 and merge receipts summarize the prepared messages, not the payload', async () => {
    const payload = 'K'.repeat(20_000);
    const log = join(dir, 'receipts', 'compression-log.jsonl');
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    try {
      const { cm } = await run('receipts', { mergeThreshold: 3 }, (cm) => {
        cm.addMessage('User', [{ type: 'text', text: `see data:image/png;base64,${payload}` }]);
        for (let i = 0; i < 60; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
      });
      cm.close();
    } finally { delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; }
    const receipts = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      event?: string; operation?: string; messages?: Array<{ textChars: number }>;
    }).filter((entry) => !entry.event && entry.messages);
    assert.ok(receipts.some((entry) => entry.operation === 'compress_l1'), 'an L1 receipt');
    assert.ok(receipts.some((entry) => /^merge_l/.test(entry.operation ?? '')), 'a merge receipt');
    for (const entry of receipts) {
      const longest = Math.max(...entry.messages!.map((message) => message.textChars));
      assert.ok(longest < payload.length, `${entry.operation}'s receipt counts ${longest} characters in one message`);
    }
  });
});

describe('the data-URL matcher at scale (V8)', () => {
  it('does not overflow the regex stack on a ~9M-character payload', () => {
    class Exposed extends AutobiographicalStrategy {
      strip(m: Array<{ content: ContentBlock[] }>) { return this.stripSerializedCompressionMedia(m); }
    }
    const messages = [{ content: [{ type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(9e6) } as ContentBlock] }];
    assert.equal(new Exposed().strip(messages), 1);
  });
  it('finds nothing, and does not overflow, in ~9M-character strings that almost match (R2-2)', () => {
    class Exposed extends AutobiographicalStrategy {
      strip(m: Array<{ content: ContentBlock[] }>) { return this.stripSerializedCompressionMedia(m); }
    }
    const payload = 'A'.repeat(5000);
    const nearMisses: Array<[string, string]> = [
      ['a type with no slash (base64url)', 'data:' + 'Ab0_-'.repeat(1.8e6)],
      ['a type with no slash (hex)', 'data:' + '0123456789abcdef'.repeat(562_500)],
      ['an unquoted parameter value', 'data:image/png;name=' + 'a'.repeat(9e6)],
      ['an unquoted parameter value before ;base64', 'data:image/png;name=' + 'a'.repeat(9e6) + ';base64,' + payload],
      ['an unterminated quoted parameter value', 'data:image/png;name="' + 'a'.repeat(9e6)],
      ['a quoted parameter value before ;base64', 'data:image/png;name="' + 'a'.repeat(9e6) + '";base64,' + payload],
    ];
    for (const [shape, text] of nearMisses) {
      const messages = [{ content: [{ type: 'text', text } as ContentBlock] }];
      let n = -1;
      assert.doesNotThrow(() => { n = new Exposed().strip(messages); }, shape);
      assert.equal(n, 0, shape);
    }
  });
});

describe('split-stitch rung', () => {
  it('sub-requests are projected (they rebuild from raw messages)', async () => {
    const payload = 'Z'.repeat(20_000);
    // Refuse the canonical request and the source-only fallback, so the chunk
    // falls through to the split-stitch rung; its sub-requests then succeed.
    const { cm, requests } = await run('split', {
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
    }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: `split me data:image/png;base64,${payload}` }]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    }, 2);
    assert.ok(requests[1].includes(MARKER), 'the refused source-only request was prepared too');
    assert.ok(!requests[1].includes(payload), 'no payload in the source-only attempt');
    const split = requests.slice(2).filter((r) => r.includes('split me'));
    assert.ok(split.length > 0, 'the split rung ran and replayed the media message');
    assert.equal(split.filter((r) => r.includes(payload)).length, 0, 'payload in a split sub-request');
    assert.ok(split.some((r) => r.includes(MARKER)));
    cm.close();
  });
  it('weighs each part by the text it sends, with serialized media replaced (R2-4)', async () => {
    const payload = 'Z'.repeat(60_000);
    let id = '';
    const { cm, requests } = await run('split-weights', {
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
      summaryTargetTokens: 2000,
    }, (cm) => {
      id = cm.addMessage('User', [{ type: 'text', text: `split me data:image/png;base64,${payload}` }]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    }, 2);
    const targets = requests.slice(2)
      .map((r) => /Target ~(\d+)/.exec(r)?.[1])
      .filter((t): t is string => t !== undefined)
      .map(Number);
    assert.ok(targets.length >= 2, `the split rung ran its parts: ${JSON.stringify(targets)}`);
    assert.ok(Math.min(...targets) > 100, `no part falls to the 100-token floor: ${JSON.stringify(targets)}`);
    const store = (cm as unknown as { messageStore: { get(id: string): unknown; getAll(): Array<{ id: string }> } }).messageStore;
    assert.ok(JSON.stringify(store.get(id)).includes(payload), 'weighing the parts leaves the stored message whole');
    // The chunk's messages are the store's live view: getAll() keeps each
    // message's object while the store is unchanged and across appends. So
    // the weights strip copies, and stripping the chunk's own messages
    // would put the marker into the view every later compile reads.
    const live = store.getAll().find((m) => m.id === id);
    assert.ok(live && JSON.stringify(live).includes(payload), 'the store\'s live view of the message keeps its payload');
    cm.close();
  });
  it('weighs a part by its tool results and tool calls too (R2-4)', async () => {
    const output = 'tool output line. '.repeat(2500);
    const { cm, requests } = await run('split-tool-weights', {
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
      summaryTargetTokens: 2000,
    }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: 'split me ' + 'text '.repeat(120) }]);
      cm.addMessage('Claude', [{ type: 'tool_use', id: 't1', name: 'fn', input: {} } as ContentBlock]);
      cm.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: output } as ContentBlock]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    }, 2);
    // The split parts are the requests after the two refused ones that carry
    // the chunk's messages: one with `split me` and its text, one with the
    // tool round, whose text blocks are shorter. Later chunks' requests carry
    // neither.
    const target = (r: string) => Number(/Target ~(\d+)/.exec(r)?.[1]);
    const parts = requests.slice(2).filter((r) => r.includes('split me') || r.includes('tool output line.'));
    const toolPart = parts.filter((r) => r.includes('tool output line.')).map(target);
    const textPart = parts.filter((r) => !r.includes('tool output line.')).map(target);
    assert.ok(toolPart.length > 0 && textPart.length > 0, `the split rung ran a part with the tool round and one without: ${JSON.stringify({ toolPart, textPart })}`);
    assert.ok(Math.min(...toolPart) > Math.max(...textPart), `the part sending the tool output takes the larger share: ${JSON.stringify({ toolPart, textPart })}`);
    cm.close();
  });
  it('weighs a part by its images too, inside a tool result\'s blocks (R2-4)', async () => {
    // A 1x1 PNG: each image is priced as the store prices one (1600 tokens by
    // default), however few bytes it holds.
    const png = { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
    const { cm, requests } = await run('split-image-weights', {
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
      summaryTargetTokens: 2000,
    }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: 'split me ' + 'text '.repeat(120) }]);
      cm.addMessage('Claude', [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} } as ContentBlock]);
      cm.addMessage('User', [{
        type: 'tool_result', toolUseId: 't1',
        content: [{ type: 'text', text: 'screenshots of the page' }, ...[1, 2, 3].map(() => ({ type: 'image', source: png }))],
      } as unknown as ContentBlock]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    }, 2);
    const target = (r: string) => Number(/Target ~(\d+)/.exec(r)?.[1]);
    const parts = requests.slice(2).filter((r) => r.includes('split me') || r.includes('screenshots of the page'));
    const imagePart = parts.filter((r) => r.includes('screenshots of the page')).map(target);
    const textPart = parts.filter((r) => !r.includes('screenshots of the page')).map(target);
    assert.ok(imagePart.length > 0 && textPart.length > 0, `the split rung ran a part with the images and one without: ${JSON.stringify({ imagePart, textPart })}`);
    assert.ok(Math.min(...imagePart) > Math.max(...textPart), `the part sending three images takes the larger share: ${JSON.stringify({ imagePart, textPart })}`);
    cm.close();
  });
  it('weighs a part by what it sends, with its thinking left out (R2-4)', async () => {
    // A signed thinking block is priced by its signature, never 0, but no
    // compression request sends it: the part holding it weighs what it sends.
    const { cm, requests } = await run('split-thinking-weights', {
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
      summaryTargetTokens: 2000,
    }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: 'split me ' + 'text '.repeat(120) }]);
      cm.addMessage('Claude', [
        { type: 'thinking', thinking: '', signature: 'sig'.repeat(10_000) } as ContentBlock,
        { type: 'text', text: 'the thought part' },
        { type: 'tool_use', id: 't1', name: 'fn', input: {} } as ContentBlock,
      ]);
      cm.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' } as ContentBlock]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    }, 2);
    const target = (r: string) => Number(/Target ~(\d+)/.exec(r)?.[1]);
    const parts = requests.slice(2).filter((r) => r.includes('split me') || r.includes('the thought part'));
    const thinkingPart = parts.filter((r) => r.includes('the thought part')).map(target);
    const textPart = parts.filter((r) => !r.includes('the thought part')).map(target);
    assert.ok(thinkingPart.length > 0 && textPart.length > 0, `the split rung ran a part with the tool round and one without: ${JSON.stringify({ thinkingPart, textPart })}`);
    assert.ok(parts.every((r) => !r.includes('sigsig')), 'no part sends the thinking block');
    assert.ok(Math.max(...thinkingPart) < Math.min(...textPart), `the part that sends only a short text and a tool round takes the smaller share: ${JSON.stringify({ thinkingPart, textPart })}`);
    cm.close();
  });
  it('weighs a part by its tool call\'s input too (R2-4)', async () => {
    const query = 'tool input word '.repeat(2500);
    const { cm, requests } = await run('split-tool-input-weights', {
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
      summaryTargetTokens: 2000,
    }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: 'split me ' + 'text '.repeat(120) }]);
      cm.addMessage('Claude', [{ type: 'tool_use', id: 't1', name: 'fn', input: { query } } as ContentBlock]);
      cm.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' } as ContentBlock]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    }, 2);
    // As above, with the tool round's bulk in the call's input: the part
    // carrying it sends the input, and takes the larger share.
    const target = (r: string) => Number(/Target ~(\d+)/.exec(r)?.[1]);
    const parts = requests.slice(2).filter((r) => r.includes('split me') || r.includes('tool input word'));
    const toolPart = parts.filter((r) => r.includes('tool input word')).map(target);
    const textPart = parts.filter((r) => !r.includes('tool input word')).map(target);
    assert.ok(toolPart.length > 0 && textPart.length > 0, `the split rung ran a part with the tool call and one without: ${JSON.stringify({ toolPart, textPart })}`);
    assert.ok(Math.min(...toolPart) > Math.max(...textPart), `the part sending the tool call's input takes the larger share: ${JSON.stringify({ toolPart, textPart })}`);
    cm.close();
  });
});

describe('matcher coverage', () => {
  class Exposed extends AutobiographicalStrategy {
    strip(m: Array<{ content: ContentBlock[] }>) { return this.stripSerializedCompressionMedia(m); }
  }
  const one = (text: string) => { const m = [{ content: [{ type: 'text', text } as ContentBlock] }]; return { n: new Exposed().strip(m), text: (m[0].content[0] as { text: string }).text }; };
  it('handles MIME parameters before ;base64', () => {
    const r = one('x data:image/png;charset=utf-8;name=a.png;base64,' + 'P'.repeat(5000) + ' y');
    assert.equal(r.n, 1); assert.match(r.text, /^x \[embedded image\/png data URL omitted/);
  });
  it('handles JSON-escaped slashes in the type and the payload', () => {
    const r = one(JSON.stringify({ u: 'data:image/png;base64,' + 'ab/cd'.repeat(1200) }).replace(/\//g, '\\/'));
    assert.equal(r.n, 1); assert.match(r.text, /\[embedded image\/png data URL omitted/);
  });
  it('still survives a ~9M-character escaped payload on V8', () => {
    assert.equal(one('data:image\\/png;base64,' + 'A\\/'.repeat(3e6)).n, 1);
  });
  it('keeps JSON escapes inside a payload, such as wrapped lines and unicode escapes, and replaces the payload whole', () => {
    // Base64 wrapped at 76 characters, serialized into a JSON string.
    const lines = Array.from({ length: 80 }, (_, i) => 'A'.repeat(75) + String.fromCharCode(66 + (i % 20)));
    const wrapped = one('"data:image/png;base64,' + lines.join('\\n') + '"');
    assert.equal(wrapped.n, 1);
    assert.equal(wrapped.text, '"[embedded image/png data URL omitted from compression prompt: ' + (80 * 76 + 79 * 2) + ' serialized payload characters]"');
    const unicode = one('data:image/png;base64,' + 'A'.repeat(3000) + '\\u002F' + 'A'.repeat(3000) + '\\u003d');
    assert.equal(unicode.n, 1);
    assert.equal(unicode.text, '[embedded image/png data URL omitted from compression prompt: 6012 serialized payload characters]');
  });
  it('leaves an escaped quote after the payload in place', () => {
    const payload = 'A'.repeat(5000);
    const quoted = one('{\\"u\\":\\"data:image/png;base64,' + payload + '\\"}');
    assert.equal(quoted.n, 1);
    assert.match(quoted.text, /: 5000 serialized payload characters\]\\"\}$/);
    const twice = one('\\\\\\"data:image/png;base64,' + payload + '\\\\\\"');
    assert.equal(twice.n, 1);
    assert.match(twice.text, /: 5000 serialized payload characters\]\\\\\\"$/);
  });
  it('matches a data URL whose type was escaped more than once', () => {
    const r = one('data:image\\\\\\/png;base64,' + 'A'.repeat(5000));
    assert.equal(r.n, 1);
    assert.equal(r.text, '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('replaces both of two data URLs that abut with no separator', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    const r = one(url + url.toUpperCase());
    assert.equal(r.n, 2);
    assert.equal(r.text, marker + marker.replace('image/png', 'IMAGE/PNG'));
  });
  it('replaces both of two data URLs that a JSON escape separates, in one pass', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    const r = one(url + '\\n' + url);
    assert.equal(r.n, 2);
    assert.equal(r.text, marker + '\\n' + marker);
    const afterShort = one('data:image/png;base64,AAAA\\n' + url);
    assert.equal(afterShort.n, 1, 'a short data URL before the escape is kept, and the next one is still found');
    assert.equal(afterShort.text, 'data:image/png;base64,AAAA\\n' + marker);
  });
  it('matches a type written with \\u escapes, and names it unescaped', () => {
    const svg = one('data:image\\u002Fsvg\\u002Bxml;base64,' + 'A'.repeat(5000));
    assert.equal(svg.n, 1);
    assert.equal(svg.text, '[embedded image/svg+xml data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('matches a type whose \\u escapes were serialized twice', () => {
    const svg = one('data:image\\\\u002Fsvg\\\\u002Bxml;base64,' + 'A'.repeat(5000));
    assert.equal(svg.n, 1);
    assert.equal(svg.text, '[embedded image/svg+xml data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('matches a MIME parameter whose value is quoted, spaces included', () => {
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    for (const parameter of [';name=\\"a.png\\"', ';name="a b.png"', ';name=\\"a b.png\\"', ';name=\\\\\\"a b.png\\\\\\"', ';name=a\\u0020b.png']) {
      const r = one('data:image/png' + parameter + ';base64,' + 'A'.repeat(5000));
      assert.equal(r.n, 1, parameter);
      assert.equal(r.text, marker, parameter);
    }
  });
  it('ends a payload before each line-break or tab escape that separates it from an abutting data URL', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    for (const separator of ['\\r\\n', '\\r', '\\t', '\\u0009', '\\u000a', '\\u000A', '\\u000d', '\\u000D', '\\u0026', '\\b']) {
      const r = one(url + separator + url);
      assert.equal(r.n, 2, separator);
      assert.equal(r.text, marker + separator + marker, separator);
    }
  });
  it('keeps an escape of a character outside base64 after the payload, and an escaped base64 character in it', () => {
    const marker = (n: number) => '[embedded image/png data URL omitted from compression prompt: ' + n + ' serialized payload characters]';
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(5000) + '\\n"').text, '"' + marker(5000) + '\\n"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(5000) + '\\u0020"').text, '"' + marker(5000) + '\\u0020"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(5000) + '\\f"').text, '"' + marker(5000) + '\\f"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(5000) + '\\U000A"').text, '"' + marker(5000) + '\\U000A"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(4998) + '\\u002B"').text, '"' + marker(5004) + '"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(4998) + '\\/"').text, '"' + marker(5000) + '"');
  });
  it('reads the same payload on a second pass when a short data URL sits before a separator', () => {
    const short = 'data:image/png;base64,' + 'A'.repeat(4095);
    const long = 'data:image/png;base64,' + 'B'.repeat(5000);
    for (const separator of ['\\n', '\\r\\n', '\\u000a', '\\t']) {
      const first = one(short + separator + long);
      assert.equal(first.n, 1, separator);
      assert.equal(first.text, short + separator + '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]', separator);
      const second = one(first.text);
      assert.equal(second.n, 0, separator);
      assert.equal(second.text, first.text, separator);
    }
  });
  it('bounds each part before the payload: names as RFC 6838 does, parameter count and values by its own bounds (R2-2)', () => {
    const payload = ';base64,' + 'A'.repeat(5000);
    const name = (n: number) => 'x' + 'y'.repeat(n - 1);
    // At a bound the whole data URL becomes its marker; past it the text is
    // left as it was.
    const replaced = (input: string, why: string) => {
      const result = one(input);
      assert.equal(result.n, 1, why);
      assert.match(result.text, /^\[embedded (\S+ )?data URL omitted from compression prompt: 5000 serialized payload characters\]$/, why);
    };
    const kept = (input: string, why: string) => {
      const result = one(input);
      assert.equal(result.n, 0, why);
      assert.equal(result.text, input, why);
    };
    replaced('data:' + name(127) + '/' + name(127) + payload, 'names of 127 characters');
    kept('data:' + name(128) + '/png' + payload, 'a type name of 128 characters');
    kept('data:image/' + name(128) + payload, 'a subtype name of 128 characters');
    replaced('data:image\\u002F' + 'p\\u006E'.repeat(63) + 'g' + payload, 'a \\u escape counts as one character of a name');
    const parameters = (n: number) => Array.from({ length: n }, (_, i) => `;p${i}=v`).join('');
    replaced('data:image/png' + parameters(16) + payload, '16 parameters');
    kept('data:image/png' + parameters(17) + payload, '17 parameters');
    replaced('data:image/png;n=' + 'v'.repeat(1024) + payload, 'a value of 1,024 characters');
    kept('data:image/png;n=' + 'v'.repeat(1025) + payload, 'a value of 1,025 characters');
    replaced('data:image/png;n="' + 'v'.repeat(1024) + '"' + payload, 'a quoted value of 1,024 characters');
    kept('data:image/png;n="' + 'v'.repeat(1025) + '"' + payload, 'a quoted value of 1,025 characters');
    replaced('data:image/png;' + name(127) + '=v' + payload, 'a parameter name of 127 characters');
    kept('data:image/png;' + name(128) + '=v' + payload, 'a parameter name of 128 characters');
  });
  it('replaces the payload but leaves the type out of the marker when the decoded type is not a media type (R2-2)', () => {
    const payload = 'A'.repeat(5000);
    for (const type of ['image\\u002Fpng\\u000Ax', 'image/png\\u0020x', 'ima\\u005Dge/png']) {
      const r = one('data:' + type + ';base64,' + payload);
      assert.equal(r.n, 1, type);
      assert.equal(r.text, '[embedded data URL omitted from compression prompt: 5000 serialized payload characters]', type);
    }
  });
  it('ends a payload at a line-break escape unless the line before it is a full 60-, 64- or 76-character wrap line (R2-3)', () => {
    const marker = (n: number) => '[embedded image/png data URL omitted from compression prompt: ' + n + ' serialized payload characters]';
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    for (const after of ['\\nIMPORTANT_PATH/foo-bar_baz= rest', '\\nhttps://example.com/x', '\\nkeep these words too, end']) {
      const r = one(url + after);
      assert.equal(r.n, 1, after);
      assert.equal(r.text, marker(5000) + after, after);
    }
    // Wrapped at 64 characters with \r\n, as PEM is: replaced whole, the
    // short last line included.
    const lines64 = Array.from({ length: 100 }, (_, i) => 'B'.repeat(63) + String.fromCharCode(67 + (i % 20)));
    const pem = one('"data:image/png;base64,' + lines64.join('\\r\\n') + '\\r\\nCCCC=="');
    assert.equal(pem.n, 1);
    assert.equal(pem.text, '"' + marker(100 * 64 + 100 * 4 + 6) + '"');
    // Wrapped at 76 with \u000a, serialized twice: the same.
    const lines76 = Array.from({ length: 80 }, () => 'D'.repeat(76));
    const mime = one('data:image/png;base64,' + lines76.join('\\\\u000a') + '\\\\u000aDD== tail');
    assert.equal(mime.n, 1);
    assert.equal(mime.text, marker(80 * 76 + 80 * 7 + 4) + ' tail');
    // Wrapped at 60 with \n, as Ruby's `pack('m')` (`Base64.encode64`) is:
    // the same.
    const lines60 = Array.from({ length: 100 }, () => 'F'.repeat(60)).join('\\n') + '\\nFF==';
    const ruby = one('data:image/png;base64,' + lines60 + ' tail');
    assert.equal(ruby.n, 1);
    assert.equal(ruby.text, marker(lines60.length) + ' tail');
    // Any other width ends the payload at its first break, under the floor,
    // so it isn't replaced at all.
    const lines70 = Array.from({ length: 100 }, () => 'E'.repeat(70)).join('\\n');
    const other = one('data:image/png;base64,' + lines70);
    assert.equal(other.n, 0, 'a 70-character first line is shorter than the floor and ends at its break');
    assert.equal(other.text, 'data:image/png;base64,' + lines70, 'the payload stays whole');
    // Another width whose first line is past the floor: that line is
    // replaced, and the break and what follows it stay.
    const longFirst = 'G'.repeat(5000);
    const rest = Array.from({ length: 3 }, () => 'G'.repeat(70)).join('\\n');
    const past = one('data:image/png;base64,' + longFirst + '\\n' + rest);
    assert.equal(past.n, 1);
    assert.equal(past.text, marker(longFirst.length) + '\\n' + rest);
  });
  it('continues a wrapped payload across each escaped form of a line break (R2-3)', () => {
    const marker = (n: number) => '[embedded image/png data URL omitted from compression prompt: ' + n + ' serialized payload characters]';
    const lines = Array.from({ length: 70 }, () => 'F'.repeat(64));
    // \r, \r\n, \u000d and \u000d\u000a, once and twice serialized.
    for (const br of ['\\r', '\\r\\n', '\\u000d', '\\u000d\\u000a', '\\\\r\\\\n', '\\\\u000d\\\\u000a']) {
      const body = lines.join(br) + br + 'FF==';
      const r = one('data:image/png;base64,' + body + ' tail');
      assert.equal(r.n, 1, br);
      assert.equal(r.text, marker(body.length) + ' tail', br);
    }
  });
  it('counts an escaped base64 character as one toward its wrap line (R2-3)', () => {
    const marker = (n: number) => '[embedded image/png data URL omitted from compression prompt: ' + n + ' serialized payload characters]';
    // Each line is 62 plain characters, one escaped, and one more: 64.
    for (const escaped of ['\\/', '\\u002B', '\\\\\\/']) {
      const line = 'G'.repeat(62) + escaped + 'G';
      const body = Array.from({ length: 70 }, () => line).join('\\n') + '\\nGG==';
      const r = one('data:image/png;base64,' + body + ' tail');
      assert.equal(r.n, 1, escaped);
      assert.equal(r.text, marker(body.length) + ' tail', escaped);
    }
  });
  it('stops a payload at an escape that runs into the next data URL (R2-3)', () => {
    // The run ends before the next URL's `data:`, which here begins inside
    // the escape `\u002D`: the payload stops before the escape, so the next
    // URL keeps its head and is replaced too.
    const marker = (type: string) => '[embedded ' + type + ' data URL omitted from compression prompt: 5000 serialized payload characters]';
    const r = one('data:image/png;base64,' + 'H'.repeat(5000) + '\\u002Data:image/gif;base64,' + 'J'.repeat(5000));
    assert.equal(r.n, 2);
    assert.equal(r.text, marker('image/png') + '\\u002' + marker('image/gif'));
  });
  it('matches a type whose first characters are \\u escapes', () => {
    const r = one('data:\\u0069mage/\\u0070ng;base64,' + 'A'.repeat(5000));
    assert.equal(r.text, '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('keeps a short data URL with a parameter apart from a base64 one that abuts it', () => {
    const marker = '[embedded image/jpeg data URL omitted from compression prompt: 5000 serialized payload characters]';
    for (const between of ['\\n', '']) {
      const r = one('data:image/png;name=a' + between + 'data:image/jpeg;base64,' + 'A'.repeat(5000));
      assert.equal(r.text, 'data:image/png;name=a' + between + marker, JSON.stringify(between));
    }
  });
  it('fails a string that almost matches in linear time', () => {
    const timed = (text: string) => {
      const started = performance.now();
      const r = one(text);
      return { n: r.n, ms: performance.now() - started };
    };
    // Counts at which overlapping choices took seconds, so a regression fails here rather than hanging.
    for (const [parameter, count] of [[';x="1"', 28], [';x=\\"1\\"', 18], [';x=\\\\\\"1\\\\\\"', 16], [';x=1', 200], [';x=\\u00411', 200]] as const) {
      const r = timed('data:a/b' + parameter.repeat(count) + ' end');
      assert.equal(r.n, 0, parameter);
      assert.ok(r.ms < 1000, `${parameter}: ${r.ms} ms`);
    }
    const slashes = timed('data:a' + '\\u002F'.repeat(5000) + ' end');
    assert.equal(slashes.n, 0);
    assert.ok(slashes.ms < 1000, `${slashes.ms} ms`);
  });
  it('reads one slash in a type, and quoted parameter values that hold \\u escapes but no other backslash or quote', () => {
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    assert.equal(one('data:image\\u002Fpng\\u002Fx;base64,' + 'A'.repeat(5000)).n, 0, 'a type has one slash');
    for (const parameter of [';name="caf\\u00e9.png"', ';name=\\"caf\\u00e9 a.png\\"']) {
      assert.equal(one('data:image/png' + parameter + ';base64,' + 'A'.repeat(5000)).text, marker, parameter);
    }
    for (const parameter of [';name="a\\\\b.png"', ';name=a"b']) {
      assert.equal(one('data:image/png' + parameter + ';base64,' + 'A'.repeat(5000)).n, 0, parameter);
    }
  });
  it('names a type behind a long run of backslashes in linear time', () => {
    const started = performance.now();
    const r = one('data:a' + '\\'.repeat(100_000) + '/b;base64,' + 'A'.repeat(5000));
    assert.ok(performance.now() - started < 1000);
    assert.equal(r.text, '[embedded a/b data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it("ends a payload before 'data' only when a data URL follows it", () => {
    const r = one('data:image/png;base64,' + 'A'.repeat(4094) + 'data: next');
    assert.equal(r.text, '[embedded image/png data URL omitted from compression prompt: 4098 serialized payload characters]: next');
  });
  it("keeps 'data' at the end of a payload when no colon follows it", () => {
    const r = one('data:image/png;base64,' + 'A'.repeat(4996) + 'data"');
    assert.equal(r.text, '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]"');
  });
  it('matches the scheme and the base64 token in any letter case', () => {
    const r = one('DATA:image/png;BASE64,' + 'P'.repeat(5000));
    assert.equal(r.n, 1); assert.match(r.text, /^\[embedded image\/png data URL omitted/);
  });
});

describe('transition request preparation', () => {
  it('projects the transition head without changing its stored message', async () => {
    const payload = 'T'.repeat(5000);
    const { membrane, requests } = recorder();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'm', headWindowTokens: 100000, recentWindowTokens: 100000,
      autoTickOnNewMessage: false,
    });
    const cm = await ContextManager.open({ path: join(dir, 'transition'), strategy, membrane: membrane as never });
    const id = cm.addMessage('User', [{ type: 'text', text: 'data:image/png;base64,' + payload }]);
    const ctx = (cm as unknown as { createStrategyContext(): never }).createStrategyContext();
    await strategy.generateTransitionSummary(ctx);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].includes(MARKER));
    assert.ok(!requests[0].includes(payload));
    assert.ok(JSON.stringify(cm.getMessage(id)).includes(payload));
    cm.close();
  });

  it("logs the head's replaced payloads with the transition request it sends", async () => {
    const { membrane, requests } = recorder();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'm', headWindowTokens: 100000, recentWindowTokens: 100000,
      autoTickOnNewMessage: false,
    });
    const cm = await ContextManager.open({ path: join(dir, 'transition-log'), strategy, membrane: membrane as never });
    cm.addMessage('User', [{ type: 'text', text: 'data:image/png;base64,' + 'T'.repeat(5000) + ' and data:image/png;base64,' + 'V'.repeat(5000) }]);
    cm.addMessage('Claude', [
      { type: 'text', text: 'and data:image/png;base64,' + 'U'.repeat(5000) },
      { type: 'tool_result', toolUseId: 't', content: 'data:image/png;base64,' + 'R'.repeat(5000) } as unknown as ContentBlock,
    ]);
    // Past the head's 8,000 characters, so the request doesn't carry it.
    cm.addMessage('User', [{ type: 'text', text: 'x'.repeat(9_000) + ' data:image/png;base64,' + 'W'.repeat(5000) }]);
    const ctx = (cm as unknown as { createStrategyContext(): never }).createStrategyContext();
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await strategy.generateTransitionSummary(ctx);
    } finally {
      console.error = original;
    }
    // The two payloads of the first message and the one in the second's
    // text: not the tool_result's, which the head's text never carries, nor
    // the third message's, past the cap.
    assert.deepEqual(lines.filter((l) => l.includes('[transition]')),
      ['[autobiographical] compression prompt: replaced 3 serialized data URL(s) with markers [transition] ns=default']);
    const sent = requests.at(-1)!;
    for (const payload of ['T', 'V', 'U', 'R', 'W']) assert.ok(!sent.includes(payload.repeat(200)), `no ${payload} payload in the request`);
    cm.close();
  });

  it("counts a head message's payload as its marker, so it doesn't spend the head's 8,000 characters", async () => {
    const payload = 'T'.repeat(20_000);
    const { membrane, requests } = recorder();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'm', headWindowTokens: 100000, recentWindowTokens: 100000,
      autoTickOnNewMessage: false,
    });
    const cm = await ContextManager.open({ path: join(dir, 'transition-head-cap'), strategy, membrane: membrane as never });
    cm.addMessage('User', [{ type: 'text', text: 'data:image/png;base64,' + payload }]);
    cm.addMessage('Claude', [{ type: 'text', text: 'SECOND-HEAD-MESSAGE' }]);
    const ctx = (cm as unknown as { createStrategyContext(): never }).createStrategyContext();
    await strategy.generateTransitionSummary(ctx);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].includes('SECOND-HEAD-MESSAGE'), 'the head goes on past the payload');
    assert.ok(!requests[0].includes('[...truncated...]'));
    cm.close();
  });
});

describe("a sharded body's price is read once per shard", () => {
  it("prices each shard once across the body's chunks, and again once a block of it changes or is added", () => {
    let scans = 0;
    class Counted extends AutobiographicalStrategy {
      docContext(chunk: unknown, ctx: unknown) { return this.detectDocContext(chunk as never, ctx as never); }
      protected override stripSerializedCompressionMedia(messages: Array<{ content: ContentBlock[] }>): number {
        scans += messages.length;
        return super.stripSerializedCompressionMedia(messages);
      }
    }
    const strategy = new Counted({ compressionModel: 'm' });
    const words = 'word '.repeat(400);
    const messages = [0, 1, 2, 3, 4].map((i) => ({ id: `s${i}`, bodyGroupId: 'g', shardIndex: i, participant: 'User', content: [{ type: 'text', text: `${i} ${words}` }] as ContentBlock[] }));
    let calibration = 1;
    const store = () => ({
      getAll: () => messages,
      getTokenCalibration: () => calibration,
      estimateTokens: (m: { content: Array<{ text?: string }> }) => Math.ceil(calibration * m.content.reduce((n, b) => n + (b.text?.length ?? 0), 0) / 4),
    });
    const ctx = { messageStore: store() };
    const totals = messages.map((m) => strategy.docContext({ messages: [m] }, ctx)?.totalTokens);
    assert.equal(scans, messages.length, 'each shard priced once across five chunks');
    assert.equal(new Set(totals).size, 1, 'every chunk reads the same total');
    // A shard whose block is replaced is priced again, and the total follows.
    messages[2]!.content = [{ type: 'text', text: 'short' }] as ContentBlock[];
    const after = strategy.docContext({ messages: [messages[0]!] }, ctx)!.totalTokens;
    assert.equal(scans, messages.length + 1, 'only the changed shard again');
    assert.ok(after < totals[0]!, `the total follows the change (${totals[0]} -> ${after})`);
    // A block appended to a shard in place, its others kept, is priced too.
    messages[3]!.content.push({ type: 'text', text: words } as ContentBlock);
    const grown = strategy.docContext({ messages: [messages[0]!] }, ctx)!.totalTokens;
    assert.equal(scans, messages.length + 2, 'the grown shard again');
    assert.ok(grown > after, `the total takes the appended block in (${after} -> ${grown})`);
    // A recalibrated store prices every shard again, and the total follows it.
    calibration = 2;
    const recalibrated = strategy.docContext({ messages: [messages[0]!] }, ctx)!.totalTokens;
    assert.equal(scans, 2 * messages.length + 2, 'every shard again after a recalibration');
    assert.ok(recalibrated > grown, `the total follows the calibration (${grown} -> ${recalibrated})`);
    // So does another store, as each strategy context's view is.
    strategy.docContext({ messages: [messages[0]!] }, { messageStore: store() });
    assert.equal(scans, 3 * messages.length + 2, 'every shard again for another store');
  });
});

describe('a sharded body is priced as a compression request sends it', () => {
  it("a data URL in the body counts as its marker toward the reading total and the chunk's share, and thinking toward neither", () => {
    class Exposed extends AutobiographicalStrategy {
      docContext(chunk: unknown, ctx: unknown) { return this.detectDocContext(chunk as never, ctx as never); }
    }
    const strategy = new Exposed({ compressionModel: 'm' });
    const text = (t: string) => [{ type: 'text', text: t }];
    const payload = 'Q'.repeat(40_000);
    const thinking = { type: 'thinking', thinking: 'T'.repeat(40_000), signature: 'sig' };
    const words = 'word '.repeat(400);
    const shard = (id: string, shardIndex: number, content: unknown[]) => ({ id, bodyGroupId: 'g', shardIndex, participant: 'User', content });
    // The chunk asked about (d) holds the payload and signed thinking, and so
    // does another shard (b): a request sends the payload as its marker and
    // strips raw messages' thinking.
    const messages = [
      shard('a', 0, text(words)),
      shard('b', 1, [thinking, ...text(words)]),
      shard('c', 2, text(words)),
      shard('d', 3, [thinking, ...text('intro data:image/png;base64,' + payload)]),
      shard('e', 4, text(words)),
    ];
    // The store's stand-in prices text and thinking alike.
    const chars = (m: { content: Array<{ text?: string; thinking?: string }> }) =>
      m.content.reduce((n, b) => n + (b.text?.length ?? 0) + (b.thinking?.length ?? 0), 0);
    const ctx = { messageStore: { getAll: () => messages, estimateTokens: (m: { content: Array<{ text?: string; thinking?: string }> }) => Math.ceil(chars(m) / 4) } };
    const doc = strategy.docContext({ messages: [messages[3]] }, ctx);
    assert.ok(doc, 'the chunk is part of a larger body');
    assert.ok(doc!.chunkTokens < payload.length / 8, `the chunk's share counts neither its payload nor its thinking: ${JSON.stringify(doc)}`);
    assert.equal(doc!.totalTokens, 4 * Math.ceil(words.length / 4) + doc!.chunkTokens,
      `the body counts its shards' text, the payload as its marker, and no thinking: ${JSON.stringify(doc)}`);
  });
});
