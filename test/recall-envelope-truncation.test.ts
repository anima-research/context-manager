/**
 * Tests for `recallEnvelope` under `maxMessageTokens`: the cap must never be
 * able to tear the envelope.
 *
 * Wrapping an answer and then truncating it is the failure this file exists
 * to forbid. The truncator keeps a prefix and appends its own marker, so an
 * enveloped answer loses its closing tag, and a cap smaller than the opener
 * emits half of one — a delimiter convention that sometimes lies, which is
 * worse than no convention at all, because a reader that meets one torn
 * envelope learns to distrust the intact ones. The render therefore truncates
 * the PROSE and envelopes what survives.
 *
 * Two properties are asserted here:
 *
 *  1. Under a cap, on every path that renders recall pairs, every emitted
 *     envelope is whole: a complete opener, a complete closer, and the
 *     truncation marker INSIDE them. This holds down to caps far smaller than
 *     the tag text itself — the envelope is not charged against
 *     `maxMessageTokens` (it is priced in `capRecallPairs`, where the
 *     accounting is load bearing), so what a tight cap buys is a few
 *     characters of prose inside intact tags rather than a broken tag.
 *  2. With the envelope off, capped renders are byte-identical to the tree
 *     before the fix, pinned against
 *     `test/fixtures/recall-envelope-truncation-golden.json`. The pre-existing
 *     null golden runs the fixtures UNCAPPED and so cannot see this
 *     restructure; a red here is the fix leaking into the default path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { ContentBlock } from '@animalabs/membrane';
import { COMBINED_RECALL_SEPARATOR_TEXT } from '../src/strategies/autobiographical.js';
import {
  HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE,
  HIERARCHICAL_FIXTURE_PLAIN_PROSE,
  type RenderedMessage,
} from './fixtures/recall-envelope-fixture.js';
import {
  CAPPED_RENDER_CASE_NAMES,
  combinedSharedBudgetCases,
  combinedSharedBudgetPrices,
  renderCappedCase,
  renderCombinedSharedBudgetCase,
  type CappedRenderCaseName,
  type CombinedSharedBudgetCase,
} from './fixtures/recall-envelope-truncation-fixture.js';

const GOLDEN = JSON.parse(
  readFileSync('test/fixtures/recall-envelope-truncation-golden.json', 'utf8'),
) as Record<string, RenderedMessage[]>;

const TRUNCATION_MARKER = /\[truncated — original was \d+ tokens\]/;
const WHOLE_ENVELOPE = /<cm-recall[^>]*>[\s\S]*?<\/cm-recall>/g;

function textOf(message: RenderedMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function recallAnswers(messages: RenderedMessage[]): RenderedMessage[] {
  const answers: RenderedMessage[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].participant === 'Context Manager') answers.push(messages[i + 1]);
  }
  return answers;
}

/**
 * Every `cm-recall` mention in the text must belong to a complete open/close
 * pair. Removing the complete pairs leaves no trace of the tag; a torn
 * envelope — a sliced opener, or an opener the cap cut before its closer —
 * survives that removal and fails here.
 */
function assertNoTornEnvelope(text: string, label: string): void {
  const residue = text.replace(WHOLE_ENVELOPE, '');
  assert.ok(
    !residue.includes('cm-recall'),
    `${label}: a cm-recall fragment survives outside a complete envelope: ${JSON.stringify(residue.slice(0, 160))}`,
  );
}

function assertEnvelopeIntact(answer: RenderedMessage, label: string): void {
  const text = textOf(answer);
  assert.match(text, /^<cm-recall[^>]*>\n/, `${label}: answer must open with a complete envelope`);
  assert.match(text, /\n<\/cm-recall>$/, `${label}: answer must close with a complete envelope`);
  assertNoTornEnvelope(text, label);
}

describe('recallEnvelope under maxMessageTokens: the cap cannot tear the envelope', () => {
  for (const name of CAPPED_RENDER_CASE_NAMES) {
    it(`${name}: every capped answer carries a whole envelope`, async () => {
      const rendered = await renderCappedCase(name, 'xml');
      const answers = recallAnswers(rendered.messages);
      assert.ok(answers.length > 0, `${name}: the capped render must still emit recall pairs`);
      for (const [index, answer] of answers.entries()) {
        assertEnvelopeIntact(answer, `${name} answer ${index}`);
      }
    });
  }

  it('puts the truncation marker inside the envelope, not after it', async () => {
    const rendered = await renderCappedCase('hierarchicalPositioned', 'xml');
    const answers = recallAnswers(rendered.messages);
    const truncated = answers.map(textOf).filter((text) => TRUNCATION_MARKER.test(text));
    assert.ok(truncated.length > 0, 'the cap must actually truncate at least one answer');
    for (const text of truncated) {
      assert.match(
        text,
        /\[truncated — original was \d+ tokens\]\n<\/cm-recall>$/,
        'the truncation marker must land inside the envelope',
      );
    }
  });

  it('keeps every envelope whole where a cap falls between concatenated answers', async () => {
    const rendered = await renderCappedCase('hierarchicalCombined', 'xml');
    const answers = recallAnswers(rendered.messages);
    assert.equal(answers.length, 1, 'the legacy combined path emits exactly one recall answer');
    const text = textOf(answers[0]);
    assertNoTornEnvelope(text, 'hierarchicalCombined');
    const openers = text.match(/<cm-recall[^>]*>/g) ?? [];
    const closers = text.match(/<\/cm-recall>/g) ?? [];
    assert.ok(openers.length > 0, 'the combined answer must carry at least one envelope');
    assert.equal(openers.length, closers.length, 'every opener in the combined turn needs its closer');
    assert.match(text, TRUNCATION_MARKER, 'this cap must truncate the combined turn');
  });

  it('renders prose inside intact tags when the cap is smaller than the envelope itself', async () => {
    for (const name of ['hierarchicalPositionedTightCap', 'hierarchicalCombinedTightCap', 'adaptiveTightCap'] as const) {
      const rendered = await renderCappedCase(name, 'xml');
      const answers = recallAnswers(rendered.messages);
      assert.ok(answers.length > 0, `${name}: a tight cap must still emit recall pairs`);
      for (const [index, answer] of answers.entries()) {
        const label = `${name} answer ${index}`;
        assertEnvelopeIntact(answer, label);
        const text = textOf(answer);
        const inside = /^<cm-recall[^>]*>\n([\s\S]*)\n<\/cm-recall>$/.exec(text);
        assert.ok(inside, `${label}: envelope body must be readable`);
        // The documented boundary behaviour: the envelope is not charged
        // against the cap, so a cap below the tag's own size still buys the
        // prose it names — never an empty envelope, never a bare fragment.
        assert.match(inside[1], TRUNCATION_MARKER, `${label}: a tight cap must truncate`);
        assert.ok(inside[1].length > 0, `${label}: the envelope must not be empty`);
      }
    }
  });
});

const ENVELOPE_OPENER = /^<cm-recall[^>]*>\n/;
const ENVELOPE_CLOSER = /\n<\/cm-recall>$/;
const TRAILING_TRUNCATION_MARKER = /\n\n\[truncated — original was \d+ tokens\]$/;
const ENVELOPE_BODY = /<cm-recall[^>]*>\n([\s\S]*?)\n<\/cm-recall>/g;

function combinedAnswerOf(messages: RenderedMessage[], label: string): RenderedMessage {
  const answers = recallAnswers(messages);
  assert.equal(answers.length, 1, `${label}: the legacy combined path emits exactly one recall answer`);
  return answers[0];
}

function envelopeBodies(answer: RenderedMessage): string[] {
  return [...textOf(answer).matchAll(ENVELOPE_BODY)].map((match) => match[1]);
}

function separatorCount(answer: RenderedMessage): number {
  return answer.content.filter(
    (block) => block.type === 'text' && block.text === COMBINED_RECALL_SEPARATOR_TEXT,
  ).length;
}

/**
 * What the render CHARGED against the cap: the prose it emitted plus the
 * separators between summaries, priced the way the strategy prices them. The
 * envelope's tags and the truncator's own marker are excluded because both are
 * documented soft-cap overshoot — they are appended after the budget is spent,
 * not bought out of it.
 */
function chargedTokens(answer: RenderedMessage): number {
  let tokens = 0;
  for (const block of answer.content) {
    if (block.type === 'thinking') {
      tokens += Math.ceil(block.thinking.length / 4);
      continue;
    }
    if (block.type !== 'text') continue;
    const charged = block.text
      .replace(ENVELOPE_OPENER, '')
      .replace(ENVELOPE_CLOSER, '')
      .replace(TRAILING_TRUNCATION_MARKER, '');
    tokens += Math.ceil(charged.length / 4);
  }
  return tokens;
}

function assertSharedBudgetShape(answer: RenderedMessage, testCase: CombinedSharedBudgetCase): void {
  const label = `${testCase.name} (cap ${testCase.maxMessageTokens})`;
  const bodies = envelopeBodies(answer);
  const text = textOf(answer);
  assertNoTornEnvelope(text, label);
  assert.equal(bodies[0], HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE, `${label}: summary one must be admitted whole`);

  if (testCase.expectation === 'stopsAfterFirstSummary') {
    assert.equal(bodies.length, 1, `${label}: emission must stop after summary one`);
    assert.equal(separatorCount(answer), 0, `${label}: a separator it cannot pay for must not be emitted`);
    assert.doesNotMatch(text, TRUNCATION_MARKER, `${label}: nothing may be truncated behind the stop`);
    return;
  }

  assert.equal(bodies.length, 2, `${label}: summary two must be admitted`);
  assert.equal(separatorCount(answer), 1, `${label}: exactly one separator sits between the two summaries`);

  if (testCase.expectation === 'bothSummariesWhole') {
    assert.equal(bodies[1], HIERARCHICAL_FIXTURE_PLAIN_PROSE, `${label}: summary two must be admitted whole`);
    assert.doesNotMatch(text, TRUNCATION_MARKER, `${label}: a cap that pays for both must truncate neither`);
    return;
  }

  const { firstSummary, separator } = combinedSharedBudgetPrices();
  const proseBudget = testCase.maxMessageTokens - firstSummary - separator;
  assert.match(bodies[1], TRUNCATION_MARKER, `${label}: summary two must carry the truncation marker`);
  const emittedProse = bodies[1].replace(TRAILING_TRUNCATION_MARKER, '');
  assert.ok(
    emittedProse.length > 0 && HIERARCHICAL_FIXTURE_PLAIN_PROSE.startsWith(emittedProse),
    `${label}: summary two's body must be a non-empty prefix of its prose, got ${JSON.stringify(emittedProse)}`,
  );
  assert.equal(
    Math.ceil(emittedProse.length / 4),
    proseBudget,
    `${label}: summary two may spend only what the separator left`,
  );
}

describe('recallEnvelope under maxMessageTokens: the combined turn spends ONE shared cap', () => {
  for (const testCase of combinedSharedBudgetCases()) {
    it(`${testCase.name}: cap ${testCase.maxMessageTokens} ${testCase.expectation}`, async () => {
      const rendered = await renderCombinedSharedBudgetCase(testCase);
      assertSharedBudgetShape(combinedAnswerOf(rendered.messages, testCase.name), testCase);
    });
  }

  it('never spends more prose and separators than the cap allows', async () => {
    for (const testCase of combinedSharedBudgetCases()) {
      const rendered = await renderCombinedSharedBudgetCase(testCase);
      const answer = combinedAnswerOf(rendered.messages, testCase.name);
      assert.ok(
        chargedTokens(answer) <= testCase.maxMessageTokens,
        `${testCase.name}: combined turn charged ${chargedTokens(answer)} tokens against a cap of ${testCase.maxMessageTokens}`,
      );
    }
  });
});

describe('recallEnvelope under maxMessageTokens: the disabled path is untouched', () => {
  for (const name of CAPPED_RENDER_CASE_NAMES) {
    it(`${name}: default mode matches the pre-fix capped golden byte-for-byte`, async () => {
      const rendered = await renderCappedCase(name);
      assert.equal(
        JSON.stringify(rendered.messages),
        JSON.stringify(GOLDEN[name]),
        `${name}: capped default-mode render drifted from the pre-fix golden — fix the fix, not the golden`,
      );
    });
  }

  it('explicit none is the same as omitting the option under a cap', async () => {
    for (const name of CAPPED_RENDER_CASE_NAMES) {
      const explicit = await renderCappedCase(name, 'none');
      assert.equal(
        JSON.stringify(explicit.messages),
        JSON.stringify(GOLDEN[name]),
        `${name}: explicit none must render the pre-fix bytes too`,
      );
    }
  });

  it('emits no envelope text at all in default mode', async () => {
    for (const name of CAPPED_RENDER_CASE_NAMES as CappedRenderCaseName[]) {
      const rendered = await renderCappedCase(name);
      for (const message of rendered.messages) {
        assert.ok(
          !textOf(message).includes('cm-recall'),
          `${name}: the disabled path must not emit envelope text`,
        );
      }
    }
  });
});
