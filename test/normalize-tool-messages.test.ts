/**
 * Tests for splitMixedToolMessages — the API-shape normalizer applied
 * in three call sites:
 *   - ContextManager.compile() (live session path)
 *   - AutobiographicalStrategy.compressChunkHierarchical (L1 compression)
 *   - AutobiographicalStrategy.executeMerge (L_n merges)
 *
 * The Anthropic API requires tool_result blocks in user turns immediately
 * following their tool_use; claude.ai-exported sessions bundle the entire
 * cycle into one assistant message, which the importer splits at ingest
 * time but already-imported sessions still carry. This helper does the
 * runtime fixup.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { splitMixedToolMessages, stripUnpairedToolBlocks } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

function mkBlocks(spec: string): ContentBlock[] {
  // shorthand: 't' = text, 'u' = tool_use, 'r' = tool_result
  return spec.split('').map((c, i) => {
    if (c === 't') return { type: 'text', text: `t${i}` };
    if (c === 'u') return { type: 'tool_use', id: `u${i}`, name: 'fn', input: {} };
    if (c === 'r') return { type: 'tool_result', toolUseId: `u${i}`, content: 'res' };
    throw new Error(`bad char: ${c}`);
  });
}

describe('splitMixedToolMessages', () => {
  it('passes through user messages with tool_result unchanged', () => {
    const input = [{ participant: 'user', content: mkBlocks('r') }];
    const out = splitMixedToolMessages(input);
    assert.equal(out.length, 1);
    assert.equal(out[0].participant, 'user');
    assert.equal(out[0].content.length, 1);
  });

  it('passes through assistant messages with no tool_result unchanged', () => {
    const input = [{ participant: 'agent', content: mkBlocks('tut') }];
    const out = splitMixedToolMessages(input);
    assert.equal(out.length, 1);
    assert.equal(out[0].participant, 'agent');
    assert.deepEqual(out[0].content.map((b) => b.type), ['text', 'tool_use', 'text']);
  });

  it('splits a bundled tool cycle into three messages', () => {
    const input = [{ participant: 'agent', content: mkBlocks('turt') }];
    const out = splitMixedToolMessages(input);
    assert.equal(out.length, 3);
    assert.equal(out[0].participant, 'agent');
    assert.deepEqual(out[0].content.map((b) => b.type), ['text', 'tool_use']);
    assert.equal(out[1].participant, 'user');
    assert.deepEqual(out[1].content.map((b) => b.type), ['tool_result']);
    assert.equal(out[2].participant, 'agent');
    assert.deepEqual(out[2].content.map((b) => b.type), ['text']);
  });

  it('merges adjacent tool_results into one user message', () => {
    const input = [{ participant: 'agent', content: mkBlocks('uurr') }];
    const out = splitMixedToolMessages(input);
    assert.equal(out.length, 2);
    assert.equal(out[0].participant, 'agent');
    assert.deepEqual(out[0].content.map((b) => b.type), ['tool_use', 'tool_use']);
    assert.equal(out[1].participant, 'user');
    assert.deepEqual(out[1].content.map((b) => b.type), ['tool_result', 'tool_result']);
  });

  it('handles alternating tool cycles in one message', () => {
    const input = [{ participant: 'agent', content: mkBlocks('urur') }];
    const out = splitMixedToolMessages(input);
    assert.deepEqual(out.map((m) => m.participant), ['agent', 'user', 'agent', 'user']);
    assert.deepEqual(out.flatMap((m) => m.content.map((b) => b.type)), [
      'tool_use', 'tool_result', 'tool_use', 'tool_result',
    ]);
  });

  it('handles tool_result at the start of an assistant message', () => {
    const input = [{ participant: 'agent', content: mkBlocks('rt') }];
    const out = splitMixedToolMessages(input);
    assert.equal(out.length, 2);
    assert.equal(out[0].participant, 'user');
    assert.deepEqual(out[0].content.map((b) => b.type), ['tool_result']);
    assert.equal(out[1].participant, 'agent');
    assert.deepEqual(out[1].content.map((b) => b.type), ['text']);
  });

  it('preserves custom agent participant names', () => {
    const input = [{ participant: 'commander', content: mkBlocks('tur') }];
    const out = splitMixedToolMessages(input);
    assert.equal(out[0].participant, 'commander');
    assert.equal(out[1].participant, 'user');
  });

  it('case-insensitive user check (User, USER all pass through)', () => {
    const input = [{ participant: 'User', content: mkBlocks('r') }];
    const out = splitMixedToolMessages(input);
    assert.equal(out.length, 1);
    assert.equal(out[0].participant, 'User');
  });

  it('walks across multiple input messages', () => {
    const input = [
      { participant: 'user', content: mkBlocks('t') },
      { participant: 'agent', content: mkBlocks('tur') },
      { participant: 'user', content: mkBlocks('t') },
    ];
    const out = splitMixedToolMessages(input);
    // user-text, agent-text+tool_use, user-tool_result, user-text
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((m) => m.participant), ['user', 'agent', 'user', 'user']);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(splitMixedToolMessages([]), []);
  });
});

describe('stripUnpairedToolBlocks', () => {
  const u = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'fn', input: {} });
  const r = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'res' });
  const t = (text: string): ContentBlock => ({ type: 'text', text });

  it('passes through paired tool_use/tool_result unchanged', () => {
    const input = [
      { participant: 'agent', content: [t('hi'), u('A')] },
      { participant: 'user', content: [r('A')] },
    ];
    const out = stripUnpairedToolBlocks(input);
    assert.deepEqual(out.map((m) => m.content.map((b) => b.type)), [
      ['text', 'tool_use'],
      ['tool_result'],
    ]);
  });

  it('strips a tool_use whose tool_result is absent (chunk-boundary tail)', () => {
    const input = [
      { participant: 'agent', content: [t('preamble'), u('A')] },
    ];
    const out = stripUnpairedToolBlocks(input);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].content.map((b) => b.type), ['text']);
  });

  it('strips a tool_result whose tool_use is absent (chunk-boundary head)', () => {
    const input = [
      { participant: 'user', content: [r('A')] },
      { participant: 'agent', content: [t('reply')] },
    ];
    const out = stripUnpairedToolBlocks(input);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].content.map((b) => b.type), ['text']);
    assert.equal((out[0].content[0] as { text: string }).text, '[tool call omitted — spans chunk boundary]');
    assert.deepEqual(out[1].content.map((b) => b.type), ['text']);
  });

  it('keeps paired blocks and strips only the unpaired ones in a mixed message', () => {
    const input = [
      { participant: 'agent', content: [u('A'), u('B'), u('C')] },
      { participant: 'user', content: [r('B'), r('C')] },
    ];
    const out = stripUnpairedToolBlocks(input);
    assert.deepEqual(out[0].content.map((b) => (b as { id?: string }).id ?? b.type), ['B', 'C']);
    assert.deepEqual(out[1].content.map((b) => (b as { toolUseId?: string }).toolUseId ?? b.type), ['B', 'C']);
  });

  it('replaces empty content with a placeholder text block', () => {
    const input = [{ participant: 'agent', content: [u('A')] }];
    const out = stripUnpairedToolBlocks(input);
    assert.equal(out.length, 1);
    assert.equal(out[0].content.length, 1);
    assert.equal(out[0].content[0].type, 'text');
    assert.match((out[0].content[0] as { text: string }).text, /tool call omitted/);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(stripUnpairedToolBlocks([]), []);
  });

  it('preserves reference identity for unchanged messages', () => {
    const msg = { participant: 'user', content: [t('hello')] };
    const out = stripUnpairedToolBlocks([msg]);
    assert.strictEqual(out[0].content, msg.content);
  });
});
