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

import { AutobiographicalStrategy } from '../../src/index.js';
import { COMBINED_RECALL_SEPARATOR_TEXT } from '../../src/strategies/autobiographical.js';
import type { AutobiographicalOptions, StoredMessage } from '../../src/types/index.js';
import {
  HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE,
  HIERARCHICAL_FIXTURE_PLAIN_PROSE,
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

/** Reaches the production token estimator the combined path spends through. */
class CombinedRecallProsePricer extends AutobiographicalStrategy {
  priceProse(text: string): number {
    return this.estimateTextOnlyTokens({ content: [{ type: 'text', text }] } as StoredMessage);
  }
}

export interface CombinedSharedBudgetPrices {
  firstSummary: number;
  separator: number;
  secondSummary: number;
}

/**
 * What the combined xml path spends on the first two hierarchical-fixture
 * summaries and on the separator between them, priced by the estimator the
 * render itself uses. Every cap below is arithmetic over these three numbers,
 * so the cases keep meaning what they say when the fixture prose changes.
 */
export function combinedSharedBudgetPrices(): CombinedSharedBudgetPrices {
  const pricer = new CombinedRecallProsePricer({});
  return {
    firstSummary: pricer.priceProse(HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE),
    separator: pricer.priceProse(COMBINED_RECALL_SEPARATOR_TEXT),
    secondSummary: pricer.priceProse(HIERARCHICAL_FIXTURE_PLAIN_PROSE),
  };
}

/** What the render owes at a given cap, once the first summary is fully in. */
export type CombinedSharedBudgetExpectation =
  | 'bothSummariesWhole'
  | 'separatorThenTruncatedSecond'
  | 'stopsAfterFirstSummary';

export interface CombinedSharedBudgetCase {
  name: string;
  maxMessageTokens: number;
  expectation: CombinedSharedBudgetExpectation;
}

/**
 * Caps that land in the seam the `CAPPED_RENDER_CASES` cannot reach: every one
 * of them fully admits the first summary, so what the render does next is
 * decided by the SEPARATOR arithmetic rather than by a cut inside summary one.
 * (`hierarchicalCombined` caps at 12 against a 13-token first summary, so its
 * cap never survives to meet a separator at all.)
 *
 * These are deliberately NOT members of `CAPPED_RENDER_CASES`: that record is
 * enumerated by the default-mode golden capture, so adding a key there would
 * move the golden. The shared-budget seam is xml-only — the flat path spends
 * its cap through one `truncateContent` call over the whole concatenation —
 * so these cases render in xml mode and leave the pinned bytes alone.
 */
export function combinedSharedBudgetCases(): CombinedSharedBudgetCase[] {
  const { firstSummary, separator, secondSummary } = combinedSharedBudgetPrices();
  return [
    {
      name: 'bothSummariesAndTheSeparatorFitExactly',
      maxMessageTokens: firstSummary + separator + secondSummary,
      expectation: 'bothSummariesWhole',
    },
    {
      name: 'separatorPlusOneTokenOfTheSecondSummary',
      maxMessageTokens: firstSummary + separator + 1,
      expectation: 'separatorThenTruncatedSecond',
    },
    {
      name: 'exactlyTheFirstSummary',
      maxMessageTokens: firstSummary,
      expectation: 'stopsAfterFirstSummary',
    },
    {
      name: 'oneTokenPastTheFirstSummary',
      maxMessageTokens: firstSummary + 1,
      expectation: 'stopsAfterFirstSummary',
    },
    {
      name: 'separatorAffordableButNoProseBehindIt',
      maxMessageTokens: firstSummary + separator,
      expectation: 'stopsAfterFirstSummary',
    },
  ];
}

export async function renderCombinedSharedBudgetCase(
  testCase: CombinedSharedBudgetCase,
): Promise<FixtureRender> {
  return renderHierarchicalFixture({
    maxMessageTokens: testCase.maxMessageTokens,
    positionedRecallPairs: false,
    recallEnvelope: 'xml',
  });
}
