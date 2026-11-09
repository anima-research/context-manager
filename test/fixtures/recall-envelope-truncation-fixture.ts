/**
 * Capped renders of the recall-envelope fixtures — the shapes
 * test/recall-envelope-truncation.test.ts asserts against, named once here so
 * the test and the golden capture cannot drift apart.
 *
 * `maxMessageTokens` is what makes the envelope's ordering load bearing: a
 * capped answer is the only render where wrapping and truncating can fight.
 * Each case pins one truncation regime:
 *
 *  - `*TightCap` uses a cap of 1 token, far SMALLER than the envelope's own
 *    tag text and the cut's marker. That is the boundary case: the envelope
 *    is not charged against the cap, so what renders is opener + the marker
 *    alone + closer.
 *  - the ordinary caps cut the fixture's summaries, which are smaller than
 *    the marker, to the marker alone too, so a positioned answer is its
 *    marker inside a whole envelope.
 *  - `hierarchicalCombinedUncut` drives the legacy
 *    `positionedRecallPairs: false` path at a cap that cuts nothing. A cap
 *    that leaves a combined answer's summaries as their markers alone refuses
 *    the compile, and the combined path's cuts, each summary's head and tail
 *    inside its own envelope, are pinned with longer summaries in
 *    test/combined-recall-answer.test.ts.
 */

import type { AutobiographicalOptions } from '../../src/types/index.js';
import {
  renderAdaptiveFixture,
  renderHierarchicalFixture,
  type FixtureRender,
} from './recall-envelope-fixture.js';

export type CappedRenderPath = 'hierarchical' | 'adaptive';

export interface CappedRenderCase {
  path: CappedRenderPath;
  options: AutobiographicalOptions;
  /** The adaptive render's compile budget, where it isn't the fixture's 900. */
  maxTokens?: number;
}

export const CAPPED_RENDER_CASES = {
  hierarchicalPositioned: {
    path: 'hierarchical',
    options: { maxMessageTokens: 3 },
  },
  hierarchicalPositionedTightCap: {
    path: 'hierarchical',
    options: { maxMessageTokens: 1 },
  },
  hierarchicalCombinedUncut: {
    path: 'hierarchical',
    options: { maxMessageTokens: 60, positionedRecallPairs: false },
  },
  adaptive: {
    path: 'adaptive',
    options: { maxMessageTokens: 12 },
  },
  adaptiveTightCap: {
    path: 'adaptive',
    options: { maxMessageTokens: 1 },
    // A raw message capped at 1 token renders as the cut's marker alone, and
    // is priced as it renders (#223), so the fixture's 30 fit 900 tokens raw.
    // A smaller budget makes the render fold, as the case needs.
    maxTokens: 300,
  },
} as const satisfies Record<string, CappedRenderCase>;

export type CappedRenderCaseName = keyof typeof CAPPED_RENDER_CASES;

export const CAPPED_RENDER_CASE_NAMES = Object.keys(
  CAPPED_RENDER_CASES,
) as CappedRenderCaseName[];

/**
 * Render one capped case in one envelope mode. `undefined` renders the case
 * with no `recallEnvelope` option at all, which is what the golden captures.
 */
export async function renderCappedCase(
  name: CappedRenderCaseName,
  mode?: 'none' | 'xml' | 'bare',
): Promise<FixtureRender> {
  const testCase: CappedRenderCase = CAPPED_RENDER_CASES[name];
  const options: AutobiographicalOptions = mode === undefined
    ? { ...testCase.options }
    : { ...testCase.options, recallEnvelope: mode };
  return testCase.path === 'hierarchical'
    ? renderHierarchicalFixture(options)
    : renderAdaptiveFixture(options, undefined, testCase.maxTokens);
}
