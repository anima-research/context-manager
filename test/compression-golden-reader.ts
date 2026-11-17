import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { NormalizedRequest } from '@animalabs/membrane';
import { mainScenarios, scenarioKey } from './compression-main-scenarios.js';

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
export function readCompressionGolden(path: string) {
  const golden = restoreUndefined(JSON.parse(readFileSync(path, 'utf8'))) as {
    source: string; sourceTree?: string; node: string; compiler: string;
    dependencyLockSha256?: string; harnessSha256?: string;
    sourceDependencyLockSha256?: string; compiledHarnessSha256?: string;
    installedDependencyLockSha256?: string; scenarioModuleSha256?: string;
    mainHarnessSha256: string; requests: Record<string, NormalizedRequest[]>;
  };
  assert.match(golden.source, /^[a-f0-9]{40}$/);
  assert.match(golden.node, /^v\d+\.\d+\.\d+$/);
  assert.match(golden.compiler, /^\d+\.\d+\.\d+$/);
  // Preserve the original capture's provenance; do not relabel its old hashes.
  const hashes = golden.sourceTree === undefined
    ? [golden.dependencyLockSha256, golden.harnessSha256]
    : [golden.sourceDependencyLockSha256, golden.compiledHarnessSha256,
      golden.installedDependencyLockSha256, golden.scenarioModuleSha256];
  if (golden.sourceTree !== undefined) assert.match(golden.sourceTree, /^[a-f0-9]{40}$/);
  for (const hash of [...hashes, golden.mainHarnessSha256]) assert.match(hash!, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(golden.requests), mainScenarios.map(scenarioKey));
  return golden;
}
