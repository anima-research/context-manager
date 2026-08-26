/**
 * Regenerates test/fixtures/recall-envelope-truncation-golden.json — the
 * capped renders of the recall-envelope fixtures with the envelope OFF.
 *
 * The envelope's truncation fix restructures how a capped recall answer is
 * built (prose is truncated, then wrapped). The pre-existing null golden runs
 * the fixtures UNCAPPED, so it cannot see that restructure at all; this
 * golden is the one that can. It was captured on the tree before the fix,
 * where `recallEnvelope: 'none'` already rendered the pre-envelope bytes, and
 * must not be re-captured to make a red go green: a diff here is the default
 * path moving, which is exactly what the fix promised not to do.
 *
 *   npm run build && node dist/test/fixtures/recall-envelope-truncation-golden.generate.js
 */

import { writeFileSync } from 'node:fs';

import {
  CAPPED_RENDER_CASE_NAMES,
  renderCappedCase,
} from './recall-envelope-truncation-fixture.js';
import type { RenderedMessage } from './recall-envelope-fixture.js';

const GOLDEN_PATH = 'test/fixtures/recall-envelope-truncation-golden.json';

async function main(): Promise<void> {
  const golden: Record<string, RenderedMessage[]> = {};
  for (const name of CAPPED_RENDER_CASE_NAMES) {
    golden[name] = (await renderCappedCase(name)).messages;
  }
  writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
  console.log(`wrote ${GOLDEN_PATH}`);
}

await main();
