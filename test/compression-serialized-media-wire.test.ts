/**
 * Serialized-media projection, asserted on the WIRE (#115 review): capture the
 * requests the summarizer actually receives, for every compression path, and
 * check Chronicle is untouched. The helper-only tests could not see that the L1
 * strip was applied to a copy the request never shipped.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
});

describe('the data-URL matcher at scale (V8)', () => {
  it('does not overflow the regex stack on a ~9M-character payload', () => {
    class Exposed extends AutobiographicalStrategy {
      strip(m: Array<{ content: ContentBlock[] }>) { return this.stripSerializedCompressionMedia(m); }
    }
    const messages = [{ content: [{ type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(9e6) } as ContentBlock] }];
    assert.equal(new Exposed().strip(messages), 1);
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
    const split = requests.slice(2).filter((r) => r.includes('split me'));
    assert.ok(split.length > 0, 'the split rung ran and replayed the media message');
    assert.equal(split.filter((r) => r.includes(payload)).length, 0, 'payload in a split sub-request');
    assert.ok(split.some((r) => r.includes(MARKER)));
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
});
