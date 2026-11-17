import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readCompressionGolden } from './compression-golden-reader.js';
import { join } from 'node:path';
import { run, Probe, KnowledgeProbe } from './compression-instructions-harness.js';
import { mainScenarios, scenarioKey, goldenReminders } from './compression-main-scenarios.js';

const golden = readCompressionGolden(join(process.cwd(), 'test/fixtures/compression-main-a81.json'));
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
