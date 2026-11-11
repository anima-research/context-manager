// Offline producer: takes a built, pinned MAIN source tree with the synthetic
// harness ported into test/. Never import a live store or instantiate a provider.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mainScenarios, scenarioKey, goldenReminders } from '../dist/test/compression-main-scenarios.js';

const [builtMain, output] = process.argv.slice(2);
if (!builtMain || !output) throw new Error('usage: node scripts/generate-compression-main-golden.mjs <built-main-root> <output.json>');
const root = resolve(builtMain);
const { run, Probe, KnowledgeProbe } = await import(pathToFileURL(`${root}/dist/test/compression-instructions-harness.js`).href);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const requests = {};
for (const s of mainScenarios) {
  requests[scenarioKey(s)] = await run(s.mode, s.pin, undefined,
    s.variant === 'reminders' ? goldenReminders : {}, s.variant === 'knowledge' ? KnowledgeProbe : Probe, s.level);
}
writeFileSync(output, JSON.stringify({
  source: 'a81d20656d8991f4d5963719535cab11703ff879',
  node: process.version,
  compiler: JSON.parse(readFileSync('node_modules/typescript/package.json', 'utf8')).version,
  dependencyLockSha256: sha256('package-lock.json'),
  harnessSha256: sha256('test/compression-instructions-harness.ts'),
  mainHarnessSha256: sha256(`${root}/test/compression-instructions-harness.ts`),
  requests,
}, (_key, value) => value === undefined ? { $cmGoldenUndefined: true } : value, 2) + '\n');
console.log(`Wrote ${Object.keys(requests).length} MAIN request sets to ${output}`);
