/**
 * Tests for `recallEnvelope` under `maxMessageTokens`: the cap must never be
 * able to tear the envelope.
 *
 * Wrapping an answer and then truncating it is the failure this file exists
 * to forbid. The cut keeps a head and a tail around its own marker, so an
 * enveloped answer cut whole would lose its opener or its closer, and a cap
 * smaller than a tag would emit half of one — a delimiter convention that sometimes lies, which is
 * worse than no convention at all, because a reader that meets one torn
 * envelope learns to distrust the intact ones. The render therefore truncates
 * the PROSE and envelopes what survives.
 *
 * Two properties are asserted here:
 *
 *  1. Under a cap, on the positioned and adaptive paths, every emitted
 *     envelope is whole: a complete opener, a complete closer, and, where
 *     the cap cuts, the cut's marker INSIDE them. This holds down to caps far
 *     smaller than the tag text itself — the envelope is not charged against
 *     `maxMessageTokens` (it is priced in `capRecallPairs`, where the
 *     accounting is load bearing), so what a tight cap leaves of a summary
 *     longer than its marker is that marker inside intact tags rather than a
 *     broken tag. The fixture's summaries are
 *     no longer than their markers, so these caps send them whole; the cuts,
 *     each marker inside its summary's envelope, are pinned in
 *     test/combined-recall-answer.test.ts, with summaries longer than the
 *     marker.
 *  2. With the envelope off, capped renders are byte-identical to the tree
 *     before the fix apart from the cut's own changes, for each of which the
 *     golden was captured again (see its generator), pinned against
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
  renderHierarchicalFixture,
  type RenderedMessage,
} from './fixtures/recall-envelope-fixture.js';
import {
  CAPPED_RENDER_CASE_NAMES,
  renderCappedCase,
  type CappedRenderCaseName,
} from './fixtures/recall-envelope-truncation-fixture.js';

const GOLDEN = JSON.parse(
  readFileSync('test/fixtures/recall-envelope-truncation-golden.json', 'utf8'),
) as Record<string, RenderedMessage[]>;

const TRUNCATION_MARKER = /\[truncated — chars \d+ to \d+ of \d+ elided here; the whole is stored (summary|message) \S+?\]/;
/** The combined answer when it holds no summary. */
const OMISSION_MARKER = '[content omitted: this message reached its token limit]';
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
  for (const name of CAPPED_RENDER_CASE_NAMES) for (const mode of ['xml', 'bare'] as const) {
    it(`${name}, ${mode}: every capped answer carries a whole envelope`, async () => {
      const rendered = await renderCappedCase(name, mode);
      const answers = recallAnswers(rendered.messages);
      assert.ok(answers.length > 0, `${name}: the capped render must still emit recall pairs`);
      for (const [index, answer] of answers.entries()) {
        const label = `${name} answer ${index}`;
        assertEnvelopeIntact(answer, label);
        if (mode === 'bare') assert.ok(!/<cm-recall [^>]*>/.test(textOf(answer)), `${label}: a bare tag carries no attribute`);
      }
    });
  }

  it('renders each summary whole inside intact tags when the cap is smaller than the envelope itself and than its marker', async () => {
    for (const name of ['hierarchicalPositionedTightCap', 'adaptiveTightCap'] as const) {
      const rendered = await renderCappedCase(name, 'xml');
      const answers = recallAnswers(rendered.messages);
      assert.ok(answers.length > 0, `${name}: a tight cap must still emit recall pairs`);
      for (const [index, answer] of answers.entries()) {
        const label = `${name} answer ${index}`;
        assertEnvelopeIntact(answer, label);
        const bodies = envelopeBodies(answer);
        assert.ok(bodies.length > 0, `${label}: envelope body must be readable`);
        // The documented boundary behaviour: the envelope is not charged
        // against the cap, and the cut is never longer than the whole, so a
        // summary no longer than its marker, as every one here is, stays
        // whole inside intact tags — never an empty envelope, never a bare
        // fragment. A longer summary's marker inside the tags is pinned in
        // test/combined-recall-answer.test.ts.
        for (const body of bodies) {
          if (name === 'adaptiveTightCap') {
            assert.match(body, /^zz-adaptive-memory-\d+ recollection of an earlier stretch$/, `${label}: the summary whole`);
          } else {
            assert.equal(body, [HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE, HIERARCHICAL_FIXTURE_PLAIN_PROSE, 'zz-memory-with-carriers'][index], `${label}: the summary whole`);
          }
        }
      }
    }
  });
});

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

describe('recallEnvelope under maxMessageTokens: the combined turn measures each summary against the cap on its own', () => {
  for (const maxMessageTokens of [13, 21]) {
    it(`cap ${maxMessageTokens}: every summary that fits the cap on its own is whole, in its own whole envelope, though together they pass it`, async () => {
      const label = `cap ${maxMessageTokens}`;
      const rendered = await renderHierarchicalFixture({ maxMessageTokens, positionedRecallPairs: false, recallEnvelope: 'xml' });
      const answer = combinedAnswerOf(rendered.messages, label);
      assertNoTornEnvelope(textOf(answer), label);
      const bodies = envelopeBodies(answer);
      assert.equal(bodies.length, 3, `${label}: all three summaries are in the answer`);
      assert.equal(separatorCount(answer), 2, `${label}: two separators join them`);
      assert.equal(bodies[0], HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE, `${label}: summary one fits, so it is whole`);
      assert.equal(bodies[1], HIERARCHICAL_FIXTURE_PLAIN_PROSE, `${label}: summary two fits, so it is whole`);
      assert.equal(bodies[2], 'zz-memory-with-carriers', `${label}: summary three fits, so it is whole`);
      assert.ok(!TRUNCATION_MARKER.test(textOf(answer)), `${label}: nothing is cut`);
    });
  }

  it('writes no omission marker when the cap leaves nothing out', async () => {
    const rendered = await renderHierarchicalFixture({
      maxMessageTokens: 100_000,
      positionedRecallPairs: false,
      recallEnvelope: 'xml',
    });
    const answer = combinedAnswerOf(rendered.messages, 'uncut');
    assert.equal(envelopeBodies(answer).length, 3, 'all three summaries are admitted');
    assert.ok(!textOf(answer).includes(OMISSION_MARKER));
  });
});

describe('recallEnvelope under maxMessageTokens: the disabled path is untouched', () => {
  for (const name of CAPPED_RENDER_CASE_NAMES) {
    it(`${name}: default mode matches the capped golden byte-for-byte`, async () => {
      const rendered = await renderCappedCase(name);
      assert.equal(
        JSON.stringify(rendered.messages),
        JSON.stringify(GOLDEN[name]),
        `${name}: capped default-mode render drifted from the golden — fix the code, not the golden`,
      );
    });
  }

  it('explicit none is the same as omitting the option under a cap', async () => {
    for (const name of CAPPED_RENDER_CASE_NAMES) {
      const explicit = await renderCappedCase(name, 'none');
      assert.equal(
        JSON.stringify(explicit.messages),
        JSON.stringify(GOLDEN[name]),
        `${name}: explicit none must render the golden bytes too`,
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
