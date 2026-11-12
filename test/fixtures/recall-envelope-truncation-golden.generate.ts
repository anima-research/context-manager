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
 * It was re-captured on purpose when the message cap began marking the
 * text blocks it drops past `maxMessageTokens` with one
 * "[content omitted: this message reached its token limit]" block. The new
 * golden differs from the old one only by that block, once in each of the two
 * combined cases, whose capped answers carry a second text block.
 *
 * It was captured again, on purpose, when a raw message the cap cuts began
 * to be priced as it renders (#223), where it was priced at the cap plus 50.
 * At these caps of 12 and 1 tokens, a capped raw message renders well under
 * that, so the adaptive render folds less: `adaptive` keeps turns
 * 8 to 29 raw beside two recall pairs, where it kept 20 to 29 beside five, and
 * `adaptiveTightCap`, which renders at 300 tokens so it still folds, keeps
 * four pairs and six raw turns, where it kept five and ten. No message's bytes
 * changed: every message in the new golden is in the old one, or is a raw
 * turn the old one left folded, cut the same way. The four hierarchical cases
 * are byte-identical.
 *
 * It was captured again, on purpose, when the cap began keeping a message's
 * head and tail around one marker naming the stored message or summary,
 * found by the strategy's own estimate, and never cutting a message to
 * something longer than its whole. Every cap here but
 * `hierarchicalCombinedUncut`'s is smaller than that marker. So a raw turn the cap cuts, every one of the adaptive renders',
 * renders as the marker alone, where it rendered its first characters and
 * the old suffix. Every summary here, and every raw turn of the
 * hierarchical renders, is no longer than its marker, so it renders whole,
 * where it was cut. The adaptive renders fold differently, since a capped
 * raw turn is priced as its marker: `adaptive` keeps 26 raw turns beside one
 * recall pair, where it kept 22 beside two, and `adaptiveTightCap` keeps six
 * raw turns beside two pairs, where it kept six beside four. The combined
 * cases at caps of 12 and 1 are gone: with every summary whole they render
 * as `hierarchicalCombinedUncut` does, and test/combined-recall-answer.test.ts
 * pins the combined answer at a cap of 1, and its cuts with longer summaries.
 * So since this capture no summary here is cut, and this golden no longer sees
 * the envelope's cut-then-wrap order. test/combined-recall-answer.test.ts pins
 * it: each long summary's head, marker and tail inside one whole envelope, on
 * the positioned, combined and adaptive paths.
 *
 * `hierarchicalCombinedUncut` pins a combined answer the cap cuts nothing
 * from.
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
