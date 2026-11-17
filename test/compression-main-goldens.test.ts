import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest } from '@animalabs/membrane';
import { run, Probe, KnowledgeProbe } from './compression-instructions-harness.js';
import { mainScenarios, scenarioKey, goldenReminders } from './compression-main-scenarios.js';

// JSON normally drops own undefined properties (for example tools). Restore
// explicit tags by assignment, not a JSON reviver which would delete the key.
function restoreUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreUndefined);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]![0] === '$cmGoldenUndefined' && entries[0]![1] === true) return undefined;
    return Object.fromEntries(entries.map(([key, child]) => [key, restoreUndefined(child)]));
  }
  return value;
}
const golden = restoreUndefined(JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/compression-main-a81.json'), 'utf8'))) as {
  source: string; sourceTree?: string; node: string; compiler: string;
  dependencyLockSha256: string; harnessSha256: string; mainHarnessSha256: string;
  requests: Record<string, NormalizedRequest[]>;
};
// Provenance is validated, not pinned forever to the pre-feature commit.
assert.match(golden.source, /^[a-f0-9]{40}$/);
if (golden.sourceTree !== undefined) assert.match(golden.sourceTree, /^[a-f0-9]{40}$/);
assert.match(golden.node, /^v\d+\.\d+\.\d+$/);
assert.match(golden.compiler, /^\d+\.\d+\.\d+$/);
for (const hash of [golden.dependencyLockSha256, golden.harnessSha256, golden.mainHarnessSha256]) {
  assert.match(hash, /^[a-f0-9]{64}$/);
}
assert.deepEqual(Object.keys(golden.requests), mainScenarios.map(scenarioKey));
for (const s of mainScenarios) {
  it(`${scenarioKey(s)}: omitted, empty and default requests match recorded baseline bytes`, async () => {
    for (const config of [undefined, {}, { preset: 'default' as const }]) {
      const actual = await run(s.mode, s.pin, config, s.variant === 'reminders' ? goldenReminders : {},
        s.variant === 'knowledge' ? KnowledgeProbe : Probe, s.level);
      assert.deepEqual(actual, golden.requests[scenarioKey(s)]);
    }
  });
}

it('historical reading/mixed keys are inherited aliases, not straddling coverage', () => {
  for (const variant of ['base', 'reminders', 'knowledge']) {
    assert.deepEqual(golden.requests[`${variant}/reading/mixed/L2`], golden.requests[`${variant}/reading/inherited/L2`]);
  }
});
