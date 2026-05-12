/**
 * Tests for tool-result pruning + tool_use input truncation (audit gap #4).
 *
 * For tool-heavy sessions, dozens or hundreds of repeated tool calls can
 * dominate context. This pruning pass keeps the most recent N results per
 * tool name (older ones get a brief marker), and optionally truncates
 * tool_use input blobs whose serialized JSON exceeds a token cap.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-tool-pruning';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input };
}
function toolResult(id: string, content: string): ContentBlock {
  return { type: 'tool_result', toolUseId: id, content };
}

describe('AutobiographicalStrategy — tool pruning (gap #4)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('keeps last N tool_results per tool, replacing older ones with a marker', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000, // keep all in recent for this test
      toolResultMaxLastN: { 'fs:read': 2 }, // keep last 2 fs:read results
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // Five tool_use+tool_result pairs for 'fs:read', plus one for 'http:get'.
    for (let i = 0; i < 5; i++) {
      const id = `tu-${i}`;
      manager.addMessage('Claude', [toolUse(id, 'fs:read', { path: `/file${i}` })]);
      manager.addMessage('user', [toolResult(id, `<file ${i} content here, pretend it is verbose>`)]);
    }
    manager.addMessage('Claude', [toolUse('tu-http', 'http:get', { url: 'x' })]);
    manager.addMessage('user', [toolResult('tu-http', 'HTTP body')]);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });

    const allBlocks = compiled.messages.flatMap(m => m.content);
    const fsResults = allBlocks.filter(
      (b): b is { type: 'tool_result'; toolUseId: string; content: string } =>
        b.type === 'tool_result' && b.toolUseId.startsWith('tu-') && b.toolUseId !== 'tu-http',
    );
    assert.equal(fsResults.length, 5, 'all 5 fs:read tool_result blocks should still be present (just rewritten)');

    const truncated = fsResults.filter(r => typeof r.content === 'string' && r.content.includes('Result truncated'));
    const intact = fsResults.filter(r => typeof r.content === 'string' && r.content.includes('file '));

    assert.equal(truncated.length, 3, 'first 3 should be truncated (older)');
    assert.equal(intact.length, 2, 'last 2 should survive intact');

    // The last two intact ones must be tu-3 and tu-4 (most recent).
    const intactIds = intact.map(r => r.toolUseId).sort();
    assert.deepEqual(intactIds, ['tu-3', 'tu-4']);

    // http:get result has no limit configured, so it stays intact.
    const httpResult = allBlocks.find(
      (b): b is { type: 'tool_result'; toolUseId: string; content: string } =>
        b.type === 'tool_result' && b.toolUseId === 'tu-http',
    );
    assert.ok(httpResult);
    assert.equal(httpResult.content, 'HTTP body', 'http:get untouched (no limit)');

    manager.close();
  });

  it('global numeric cap applies to all tools', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      toolResultMaxLastN: 1, // keep only the most recent result per tool, period
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    for (let i = 0; i < 3; i++) {
      manager.addMessage('Claude', [toolUse(`a-${i}`, 'tool-a', { i })]);
      manager.addMessage('user', [toolResult(`a-${i}`, `result-a-${i}`)]);
      manager.addMessage('Claude', [toolUse(`b-${i}`, 'tool-b', { i })]);
      manager.addMessage('user', [toolResult(`b-${i}`, `result-b-${i}`)]);
    }

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const allBlocks = compiled.messages.flatMap(m => m.content);
    const intactA = allBlocks.filter(
      (b): b is { type: 'tool_result'; toolUseId: string; content: string } =>
        b.type === 'tool_result' && b.toolUseId.startsWith('a-') && typeof b.content === 'string' && b.content.startsWith('result-'),
    );
    const intactB = allBlocks.filter(
      (b): b is { type: 'tool_result'; toolUseId: string; content: string } =>
        b.type === 'tool_result' && b.toolUseId.startsWith('b-') && typeof b.content === 'string' && b.content.startsWith('result-'),
    );

    assert.equal(intactA.length, 1, 'only 1 result-a survives (global cap=1)');
    assert.equal(intactB.length, 1, 'only 1 result-b survives');
    assert.equal(intactA[0].toolUseId, 'a-2', 'most recent a survives');
    assert.equal(intactB[0].toolUseId, 'b-2', 'most recent b survives');
  });

  it('truncates oversized tool_use input when toolUseInputMaxTokens is set', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      toolUseInputMaxTokens: 10, // ~40 chars
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    manager.addMessage('Claude', [
      toolUse('x', 'fs:write', {
        path: '/very-long-file-name.txt',
        content: 'X'.repeat(2000), // ≈ 500 tokens — well over cap
        encoding: 'utf-8',
      }),
    ]);
    manager.addMessage('user', [toolResult('x', 'ok')]);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const useBlock = compiled.messages
      .flatMap(m => m.content)
      .find((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use');
    assert.ok(useBlock);

    assert.equal(useBlock.input._truncated, true, 'input must be flagged as truncated');
    assert.ok(typeof useBlock.input._originalTokens === 'number');
    assert.ok(Array.isArray(useBlock.input._keys));
    // The original keys list should have been preserved as a hint
    assert.ok((useBlock.input._keys as string[]).includes('path'));
    assert.ok((useBlock.input._keys as string[]).includes('content'));

    // The original `content` body must be GONE (this is the whole point)
    assert.equal((useBlock.input as Record<string, unknown>).content, undefined);
  });

  it('does nothing when both pruning configs are unset (default)', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    for (let i = 0; i < 4; i++) {
      manager.addMessage('Claude', [toolUse(`t-${i}`, 'unused', { i })]);
      manager.addMessage('user', [toolResult(`t-${i}`, `body-${i}`)]);
    }

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const allBlocks = compiled.messages.flatMap(m => m.content);
    const intact = allBlocks.filter(
      b => b.type === 'tool_result' && typeof (b as any).content === 'string' && ((b as any).content as string).startsWith('body-'),
    );
    assert.equal(intact.length, 4, 'all results untouched when no pruning configured');
  });
});
