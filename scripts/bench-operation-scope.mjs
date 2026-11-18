// Offline, real Chronicle stores and deterministic provider output (not provider latency).
// Compare this SAME harness against built trees, e.g. node scripts/bench-operation-scope.mjs <dist/src/index.js>.
// --smoke checks reachability cheaply; full sizes include history-sized reloads.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const { AutobiographicalStrategy, ContextManager } = await import(pathToFileURL(resolve(process.argv[2] ?? 'dist/src/index.js')));
const smoke = process.argv.includes('--smoke');
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)];
for (const size of smoke ? [32] : [32, 256, 1024]) {
  for (const mode of ['raw', 'compressed', 'adaptive']) {
    const dir = mkdtempSync(join(tmpdir(), 'ob-'));
    let providerCalls = 0, cappedForSendCalls = 0, buildPickerCalls = 0;
    const strategy = new AutobiographicalStrategy({
      autoTickOnNewMessage: false, compressionModel: 'offline',
      targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
      minChunkCharsForLLM: 0, l1HoldbackChunks: 0, hierarchical: true,
      mergeThreshold: 6, adaptiveResolution: mode === 'adaptive', foldingStrategy: 'kv-stable',
      quarantineAlarmIntervalMs: 0,
    });
    // Same probes on each compared tree; measurements include this small shared
    // instrumentation cost. Assert paths rather than timing thresholds in tests.
    for (const key of ['cappedForSend', 'buildPicker']) {
      const method = strategy[key];
      strategy[key] = function (...args) {
        if (key === 'cappedForSend') cappedForSendCalls++; else buildPickerCalls++;
        return Reflect.apply(method, this, args);
      };
    }
    const membrane = { complete: async () => ({ stopReason: 'end_turn',
      content: [{ type: 'text', text: `Summary ${++providerCalls}: representative ordinary events.` }],
      usage: { inputTokens: 500, outputTokens: 20 },
    }) };
    const manager = await ContextManager.open({ path: dir, strategy, membrane });
    const budget = { maxTokens: 1000000, reserveForResponse: 100 };
    try {
      const adds = [];
      for (let i = 0; i < size; i++) {
        const start = performance.now();
        manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `MSG-${i} ${'word '.repeat(110)}` }]);
        adds.push(performance.now() - start);
      }
      const compressions = [];
      if (mode !== 'raw') {
        let settled = false;
        for (let round = 0; round < size; round++) {
          await manager.compile(budget);
          const before = providerCalls, start = performance.now();
          await manager.tick();
          await manager.tick();
          if (providerCalls > before) compressions.push(performance.now() - start);
          else { settled = true; break; }
        }
        assert.ok(settled, 'compression must settle');
        assert.ok(providerCalls > 0 && strategy.summaries.length > 0, `${mode}: no compressed fixture`);
      }
      const summaries = strategy.summaries.length;
      const measuredBudget = mode === 'raw' ? budget : { maxTokens: Math.max(1200, size * 30), reserveForResponse: 100 };
      const compiled = await manager.compile(measuredBudget);
      const rendersSummary = JSON.stringify(compiled).includes('Summary ');
      if (mode !== 'raw') assert.ok(rendersSummary, `${mode}: measured compile must render compressed content`);
      const compiles = [];
      const warmups = smoke ? 1 : 10, samples = smoke ? 2 : 30;
      for (let i = 0; i < warmups + samples; i++) {
        const start = performance.now();
        await manager.compile(measuredBudget);
        if (i >= warmups) compiles.push(performance.now() - start);
      }
      const start = performance.now();
      await manager.setStrategy(strategy);
      const reloadMs = performance.now() - start;
      assert.ok(cappedForSendCalls > 0);
      if (mode === 'adaptive') assert.ok(buildPickerCalls > 0);
      console.log(JSON.stringify({ mode, size, summaries, rendersSummary, providerCalls, cappedForSendCalls, buildPickerCalls,
        addMessageMedianMs: median(adds), compileMedianMs: median(compiles),
        compressionMedianMs: compressions.length ? median(compressions) : null, reloadMs }));
    } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
  }
}
