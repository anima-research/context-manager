/** Offline fixture capture: run against a built historical entrypoint, not HEAD. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [entrypoint, kind, output] = process.argv.slice(2);
assert.ok(entrypoint && ['claim', 'snapshot'].includes(kind) && output, 'entrypoint claim|snapshot output.json');
const { AutobiographicalStrategy, ContextManager } = await import(pathToFileURL(resolve(entrypoint)).href);
const path = mkdtempSync(join(tmpdir(), 'cm-legacy-capture-'));
const strategy = new AutobiographicalStrategy({ compressionModel: 'historical-fixture', targetChunkTokens: 100,
  recentWindowTokens: 0, headWindowTokens: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0,
  mergeThreshold: 99, compressionRefusalCurveFallbacks: 0 });
const membrane = { complete: async () => ({ content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 } }) };
const manager = await ContextManager.open({ path, strategy, membrane });
try {
  for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `Historical synthetic message ${i} ${'substantive '.repeat(12)}` }]);
  await manager.compile();
  await strategy.compressChunkHierarchical(strategy.chunks[0], manager.createStrategyContext());
  const stateId = `default/autobio:compression-refusal-quarantine${kind === 'claim' ? '-events' : ''}`;
  const captured = manager.getStore().getStateJson(stateId);
  assert.ok(Array.isArray(captured) && captured.length > 0, 'historical writer must emit its own container');
  if (kind === 'claim') {
    assert.ok(captured.some(event => event.kind === 'claim'));
    assert.ok(captured.some(event => event.kind === 'exhausted'));
  } else assert.ok(captured[0].chunkSourceHash);
  writeFileSync(output, JSON.stringify(captured, null, 2) + '\n');
} finally { manager.close(); rmSync(path, { recursive: true, force: true }); }
