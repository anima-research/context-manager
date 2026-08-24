/**
 * Capped renders of the recall-envelope fixtures — the shapes
 * test/recall-envelope-truncation.test.ts asserts against, named once here so
 * the test and the golden capture cannot drift apart.
 *
 * `maxMessageTokens` is what makes the envelope's ordering load bearing: a
 * capped answer is the only render where wrapping and truncating can fight.
 * Each case pins one truncation regime:
 *
 *  - `*TightCap` uses a cap of 1 token (4 characters), far SMALLER than the
 *    envelope's own tag text. That is the boundary case: the envelope is not
 *    charged against the cap, so what renders is opener + the few characters
 *    the cap bought + the truncator's marker + closer.
 *  - the ordinary caps sit mid-prose, so an answer is cut but not obliterated.
 *  - the `combined*` cases drive the legacy `positionedRecallPairs: false`
 *    path, whose single turn concatenates every selected summary and is
 *    therefore the one place a cap can fall BETWEEN two envelopes.
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
  hierarchicalCombined: {
    path: 'hierarchical',
    options: { maxMessageTokens: 12, positionedRecallPairs: false },
  },
  hierarchicalCombinedTightCap: {
    path: 'hierarchical',
    options: { maxMessageTokens: 1, positionedRecallPairs: false },
  },
  adaptive: {
    path: 'adaptive',
    options: { maxMessageTokens: 12 },
  },
  adaptiveTightCap: {
    path: 'adaptive',
    options: { maxMessageTokens: 1 },
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
  mode?: 'none' | 'xml',
): Promise<FixtureRender> {
  const testCase: CappedRenderCase = CAPPED_RENDER_CASES[name];
  const options: AutobiographicalOptions = mode === undefined
    ? { ...testCase.options }
    : { ...testCase.options, recallEnvelope: mode };
  return testCase.path === 'hierarchical'
    ? renderHierarchicalFixture(options)
    : renderAdaptiveFixture(options);
}
