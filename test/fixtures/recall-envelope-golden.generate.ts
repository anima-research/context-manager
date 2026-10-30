/**
 * Regenerates test/fixtures/recall-envelope-golden.json — the mechanically
 * captured render of the recall-envelope fixtures with the envelope OFF.
 *
 * The default mode's compatibility promise is byte-identity with the render
 * that existed before the envelope was added, from the same store, so this
 * golden was first captured on the pre-change tree, and is re-captured only
 * for a change to the render made on purpose outside the envelope, such as
 * the store's read-back, never to make a red go green: any other diff here IS
 * the compat break the null test exists to catch.
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
