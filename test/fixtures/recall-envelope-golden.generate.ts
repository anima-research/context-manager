/**
 * Regenerates test/fixtures/recall-envelope-golden.json — the mechanically
 * captured render of the recall-envelope fixtures with the envelope OFF.
 *
 * The default mode's compatibility promise is byte-identity with the render
 * that existed before the envelope was added, so this golden was captured on
 * the pre-change tree and must not be re-captured to make a red go green: a
 * diff here IS the compat break the null test exists to catch.
 *
 *   npm run build && node dist/test/fixtures/recall-envelope-golden.generate.js
 */

import { writeFileSync } from 'node:fs';

import { renderAdaptiveFixture, renderHierarchicalFixture } from './recall-envelope-fixture.js';

const GOLDEN_PATH = 'test/fixtures/recall-envelope-golden.json';

async function main(): Promise<void> {
  const golden = {
    hierarchical: (await renderHierarchicalFixture()).messages,
    adaptive: (await renderAdaptiveFixture()).messages,
  };
  writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
  console.log(`wrote ${GOLDEN_PATH}`);
}

await main();
