// Offline, real Chronicle stores; compare the same harness against built trees.
// node scripts/bench-operation-scope.mjs /absolute/path/to/dist/src/index.js
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const { AutobiographicalStrategy, ContextManager } = await import(pathToFileURL(resolve(process.argv[2] ?? 'dist/src/index.js')));
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)];
for (const size of [32, 256, 1024]) {
  const dir = mkdtempSync(join(tmpdir(), 'ob-'));
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
  const manager = await ContextManager.open({ path: dir, strategy });
  try {
    const adds = [];
    for (let i = 0; i < size; i++) {
      const start = performance.now();
      manager.addMessage('user', [{ type: 'text', text: `message ${i}: ${'representative history '.repeat(12)}` }]);
      adds.push(performance.now() - start);
    }
    const compiles = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      manager.compile({ maxTokens: 1000000, reserveForResponse: 100 });
      if (i >= 5) compiles.push(performance.now() - start);
    }
    console.log(JSON.stringify({ size, addMessageMedianMs: median(adds), compileMedianMs: median(compiles) }));
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
}
