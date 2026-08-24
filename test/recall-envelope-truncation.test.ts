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
import type { RenderedMessage } from './fixtures/recall-envelope-fixture.js';
import {
  CAPPED_RENDER_CASE_NAMES,
  renderCappedCase,
  type CappedRenderCaseName,
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
