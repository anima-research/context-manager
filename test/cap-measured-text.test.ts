/**
 * `capMeasuredText`: the text the per-message cap measures for a message or
 * a summary, read through the agent's view, so a reader that pages it (agent-
 * framework's `message_read`) reads offsets the cap's marker names. For a
 * raw message that's its send form (a result tool pruning leaves out reads as
 * its marker); for a summary, its answer prose; for a call's input, the JSON
 * the input cap measures. A row the agent's view doesn't hold reads as null.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy, WindowedPassthroughStrategy } from '../src/index.js';
import type { ContextStrategy, StoredMessage } from '../src/index.js';
import { SeedableStrategy } from './fixtures/recall-envelope-fixture.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content });

async function withManager(
  strategy: ContextStrategy,
  run: (manager: ContextManager) => Promise<void> | void,
  viewFilter?: (message: StoredMessage) => boolean,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'zz-cap-measured-'));
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, ...(viewFilter ? { viewFilter } : {}) });
  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const memory = (options: Record<string, unknown> = {}) => new AutobiographicalStrategy({
  headWindowTokens: 0, recentWindowTokens: 1_000_000, ...options,
} as ConstructorParameters<typeof AutobiographicalStrategy>[0]);

describe('capMeasuredText', () => {
  it("joins a message's text blocks and string tool results in order, with no separator, as the cap counts them", async () => {
    await withManager(memory(), (cm) => {
      cm.addMessage('Claude', [toolUse('t1', 'fs:read', { path: '/a' })]);
      const id = cm.addMessage('user', [toolResult('t1', 'zz-result'), text('zz-one '), { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } } as ContentBlock, text('zz-two')]);
      assert.equal(cm.capMeasuredText({ id }), 'zz-resultzz-one zz-two');
    });
  });

  it('reads a message in its send form: a result tool pruning leaves out reads as its marker', async () => {
    await withManager(memory({ toolResultMaxLastN: { 'fs:read': 0 } }), (cm) => {
      cm.addMessage('Claude', [toolUse('t1', 'fs:read', { path: '/a' })]);
      const id = cm.addMessage('user', [toolResult('t1', 'zz-secret-file-body')]);
      assert.equal(cm.capMeasuredText({ id }), "[result of tool 'fs:read' left out: this context shows none of its results]");
    });
  });

  it("reads a call's input whole, as the JSON the input cap measures, by the call's id", async () => {
    const input = { path: '/notes.md', text: 'zz-' + 'w'.repeat(500) };
    await withManager(memory({ toolUseInputMaxTokens: 10 }), (cm) => {
      const id = cm.addMessage('Claude', [text('writing'), toolUse('t9', 'fs:write', input)]);
      assert.equal(cm.capMeasuredText({ id, toolUseId: 't9' }), JSON.stringify(input));
      assert.equal(cm.capMeasuredText({ id, toolUseId: 'no-such-call' }), null, 'a call the message holds no part of');
    });
  });

  it("reads a summary's answer prose by its id", async () => {
    const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8 });
    await withManager(strategy, (cm) => {
      const a = cm.addMessage('user', [text('zz-turn-one')]);
      cm.addMessage('user', [text('zz-turn-latest')]);
      strategy.seedSummary({ id: 'L1-zz', level: 1, content: 'zz-memory of turn one', tokens: 6, sourceLevel: 0, sourceIds: [a], sourceRange: { first: a, last: a } });
      assert.equal(cm.capMeasuredText({ id: 'L1-zz' }), 'zz-memory of turn one');
    });
  });

  it("is null for a row the agent's view leaves out, a row it isn't shown yet, and an id nothing has", async () => {
    await withManager(memory(), (cm) => {
      const hidden = cm.addMessage('user', [text('zz-hidden')]);
      const shown = cm.addMessage('user', [text('zz-shown')]);
      assert.equal(cm.capMeasuredText({ id: shown }), 'zz-shown', 'premise: a row the view holds reads');
      assert.equal(cm.capMeasuredText({ id: hidden }), null, 'the view filter leaves it out');
      assert.equal(cm.capMeasuredText({ id: 'no-such-row' }), null);
    }, (message) => !JSON.stringify(message.content).includes('zz-hidden'));

    await withManager(memory(), (cm) => {
      const presented = cm.addMessage('user', [text('zz-presented')]);
      cm.presentRows([presented]);
      const later = cm.addMessage('user', [text('zz-not-yet')]);
      assert.equal(cm.capMeasuredText({ id: presented }), 'zz-presented', 'premise: a presented row reads');
      assert.equal(cm.capMeasuredText({ id: later }), null, 'stored, not yet presented to the agent');
    });
  });

  it('reads a message as windowed passthrough stores it', async () => {
    await withManager(new WindowedPassthroughStrategy({ imageStripDepthTokens: 0 } as ConstructorParameters<typeof WindowedPassthroughStrategy>[0]), (cm) => {
      const id = cm.addMessage('user', [text('zz-a'), text('zz-b')]);
      assert.equal(cm.capMeasuredText({ id }), 'zz-azz-b');
    });
  });

  it('reads no call input under windowed passthrough, which cuts none', async () => {
    await withManager(new WindowedPassthroughStrategy({ imageStripDepthTokens: 0 } as ConstructorParameters<typeof WindowedPassthroughStrategy>[0]), (cm) => {
      const id = cm.addMessage('assistant', [text('zz-a'), toolUse('t9', 'search', { q: 'zz-q' })]);
      assert.equal(cm.capMeasuredText({ id }), 'zz-a');
      assert.equal(cm.capMeasuredText({ id, toolUseId: 't9' }), null, 'a call the message holds');
    });
  });

  it('is null under a strategy that has no per-message cap', async () => {
    await withManager(new PassthroughStrategy(), (cm) => {
      const id = cm.addMessage('user', [text('zz-a')]);
      assert.equal(cm.capMeasuredText({ id }), null);
    });
  });
});
