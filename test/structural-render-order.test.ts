import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const text = (body: string): ContentBlock => ({ type: 'text', text: body });
const use = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read', input: { payload: 'x'.repeat(200) } });
const result = (id: string, body = `real result ${id}`): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: body });
const missingResultText = '[tool result unavailable — omitted during context compression]';
type Message = { participant: string; content: ContentBlock[] };
const agent = (...content: ContentBlock[]): Message => ({ participant: 'agent', content });
const user = (...content: ContentBlock[]): Message => ({ participant: 'user', content });

async function render(messages: Message[], adaptiveResolution: boolean): Promise<Message[]> {
  const path = mkdtempSync(join(tmpdir(), 'cm-render-order-'));
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution,
    headWindowTokens: 0,
    recentWindowTokens: 100_000,
    toolResultMaxLastN: 1,
    toolUseInputMaxTokens: 10,
  });
  const manager = await ContextManager.open({ path: join(path, 'store'), strategy });
  try {
    for (const message of messages) {
      manager.addMessage(message.participant, structuredClone(message.content));
    }
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    // The adaptive path also places cache markers. Compare rendered history,
    // not selector-specific cache metadata or independently generated store IDs.
    return compiled.messages.map(({ participant, content }) => ({ participant, content }));
  } finally {
    await manager.close();
    rmSync(path, { recursive: true, force: true });
  }
}

const paired = [agent(use('A')), user(result('A')), agent(use('B')), user(result('B'))];

describe('structural render ordering across adaptive and hierarchical selectors', () => {
  for (const markerId of ['A', 'B']) {
    it(`counts genuine result ${markerId} whose text matches the missing-result marker`, async () => {
      const messages = [
        agent(use('A')), user(result('A', markerId === 'A' ? missingResultText : 'real result A')),
        agent(use('B')), user(result('B', markerId === 'B' ? missingResultText : 'real result B')),
        agent(use('MISSING')), user(text('continue without a result')),
      ];
      for (const adaptiveResolution of [true, false]) {
        const results = (await render(messages, adaptiveResolution))
          .flatMap(message => message.content).filter(block => block.type === 'tool_result');
        assert.match(String(results.find(block => block.toolUseId === 'A')?.content), /Result truncated/,
          'the older genuine result must be truncated even when one result matches the marker');
        assert.equal(results.find(block => block.toolUseId === 'B')?.content,
          markerId === 'B' ? missingResultText : 'real result B');
        assert.equal(results.find(block => block.toolUseId === 'MISSING')?.content, missingResultText,
          'the generated stub remains distinct from identically worded real output');
      }
    });
  }

  for (const [name, messages] of [
    ['missing result stub', [...paired, agent(use('MISSING')), user(text('continue without that result'))]],
    ['tail result stub', [agent(use('A')), user(result('A')), agent(use('B')), user(result('B'), use('TAIL'))]],
    ['duplicate result removed by pairing', [...paired, user(result('B')), agent(text('done'))]],
    ['displaced result relocated before pruning', [agent(use('A')), agent(use('B')), user(result('B')), user(result('A')), agent(text('done'))]],
  ] satisfies Array<[string, Message[]]>) {
    it(`${name}: both selectors retain the newest real result`, async () => {
      const adaptive = await render(messages, true);
      const hierarchical = await render(messages, false);
      assert.deepEqual(adaptive, hierarchical, 'identical history and config must produce identical tool retention');
      const blocks = adaptive.flatMap(message => message.content);
      const results = blocks.filter(block => block.type === 'tool_result');
      assert.equal(results.find(block => block.toolUseId === 'B')?.content, 'real result B');
      assert.match(String(results.find(block => block.toolUseId === 'A')?.content), /Result truncated/);
      assert.equal(results.filter(block => block.toolUseId === 'B').length, 1, 'repair removes duplicate results before counting');
      if (name === 'missing result stub' || name === 'tail result stub') {
        const id = name === 'tail result stub' ? 'TAIL' : 'MISSING';
        const stub = results.find(block => block.toolUseId === id);
        assert.equal(stub?.content, missingResultText);
        assert.deepEqual(Object.keys(stub!).sort(), ['content', 'toolUseId', 'type'], 'provenance must not add wire fields');
      }
      for (const block of blocks) {
        if (block.type === 'tool_use') assert.equal(block.input._truncated, true, 'input caps apply on both paths');
      }
    });
  }
});
