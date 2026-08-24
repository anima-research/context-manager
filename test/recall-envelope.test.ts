/**
 * Tests for `recallEnvelope`: opt-in structural delimiting of recall answers.
 *
 * A recall pair's answer is model prose with no end delimiter — the Q-side
 * label opens the memory and the turn boundary is all that closes it, which
 * fleet operators report instances reading straight past. Under
 * `recallEnvelope: 'xml'` each answer's prose is fenced by
 * `<cm-recall id level span>` … `</cm-recall>`.
 *
 * Two properties matter more than the feature itself:
 *
 *  1. The default ('none') is byte-identical to the render that existed
 *     before the envelope was added. That is pinned against
 *     `test/fixtures/recall-envelope-golden.json`, captured MECHANICALLY on
 *     the pre-change tree (see recall-envelope-golden.generate.ts). A red
 *     here is a compat break in the change, never a stale golden.
 *  2. Nothing downstream keys on answer bytes. Q-side labels are untouched in
 *     both modes, and zero-recall surgery removes enveloped pairs exactly as
 *     it removes bare ones.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy } from '../src/index.js';
import {
  buildRecallEnvelopeTags,
  recallEnvelopeAddedText,
  wrapRecallAnswerContent,
} from '../src/recall-envelope.js';
import { transformZeroRecallCompression } from '../src/surgery/zero-recall-compression.js';
import type { SummaryEntry } from '../src/types/index.js';
import {
  renderAdaptiveFixture,
  renderHierarchicalFixture,
  type FixtureSummary,
  type RenderedMessage,
} from './fixtures/recall-envelope-fixture.js';

const GOLDEN = JSON.parse(
  readFileSync('test/fixtures/recall-envelope-golden.json', 'utf8'),
) as { hierarchical: RenderedMessage[]; adaptive: RenderedMessage[] };

/** Probe for the protected surfaces the envelope touches. */
class EnvelopeProbeStrategy extends AutobiographicalStrategy {
  priceRecallLadder(summaries: SummaryEntry[], maxTokens: number): { kept: SummaryEntry[]; keptTokens: number } {
    return this.capRecallPairs(summaries, maxTokens);
  }
}

function fakeSummary(overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  return {
    id: 'L1-7',
    level: 1,
    content: 'zz-memory-body',
    tokens: 4,
    sourceLevel: 0,
    sourceIds: ['zz-msg-1'],
    sourceRange: { first: 'zz-msg-1', last: 'zz-msg-4' },
    created: 0,
    ...overrides,
  };
}

function textOf(message: RenderedMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function isRecallQuestion(message: RenderedMessage): boolean {
  return message.participant === 'Context Manager';
}

/** Answers are the message immediately after a recall question. */
function recallAnswers(messages: RenderedMessage[]): RenderedMessage[] {
  const answers: RenderedMessage[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (isRecallQuestion(messages[i])) answers.push(messages[i + 1]);
  }
  return answers;
}

function parseEnvelopeAttributes(text: string): Record<string, string> {
  const open = /^<cm-recall([^>]*)>/.exec(text);
  assert.ok(open, `answer does not open with a cm-recall tag: ${JSON.stringify(text.slice(0, 80))}`);
  const attributes: Record<string, string> = {};
  for (const match of open[1].matchAll(/(\w+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

describe('recallEnvelope: default mode renders the pre-change bytes', () => {
  it('hierarchical path (per-id labels) matches the golden byte-for-byte', async () => {
    const rendered = await renderHierarchicalFixture();
    assert.equal(
      JSON.stringify(rendered.messages),
      JSON.stringify(GOLDEN.hierarchical),
      'default-mode render drifted from the pre-change golden — fix the change, not the golden',
    );
  });

  it('adaptive path (uniform label) matches the golden byte-for-byte', async () => {
    const rendered = await renderAdaptiveFixture();
    assert.equal(
      JSON.stringify(rendered.messages),
      JSON.stringify(GOLDEN.adaptive),
      'default-mode render drifted from the pre-change golden — fix the change, not the golden',
    );
  });

  it('explicit none is the same as omitting the option', async () => {
    const explicit = await renderHierarchicalFixture({ recallEnvelope: 'none' });
    assert.equal(JSON.stringify(explicit.messages), JSON.stringify(GOLDEN.hierarchical));
  });
});

describe('recallEnvelope: xml mode wraps every answer', () => {
  it('envelopes every recall answer on the hierarchical path, questions unchanged', async () => {
    const plain = await renderHierarchicalFixture();
    const wrapped = await renderHierarchicalFixture({ recallEnvelope: 'xml' });

    assert.equal(wrapped.messages.length, plain.messages.length, 'envelope must not add or drop messages');
    const answers = recallAnswers(wrapped.messages);
    assert.ok(answers.length >= 3, `fixture should render at least 3 recall pairs, got ${answers.length}`);
    for (const answer of answers) {
      const text = textOf(answer);
      assert.match(text, /^<cm-recall [^>]*>\n/, 'answer must open with the envelope');
      assert.match(text, /\n<\/cm-recall>$/, 'answer must close with the envelope');
    }

    const plainQuestions = plain.messages.filter(isRecallQuestion).map(textOf);
    const wrappedQuestions = wrapped.messages.filter(isRecallQuestion).map(textOf);
    assert.deepEqual(wrappedQuestions, plainQuestions, 'Q-side labels must be identical in both modes');
  });

  it('envelopes the adaptive path uniform-label pairs too', async () => {
    const plain = await renderAdaptiveFixture();
    const wrapped = await renderAdaptiveFixture({ recallEnvelope: 'xml' });

    const answers = recallAnswers(wrapped.messages);
    assert.ok(answers.length >= 4, `fixture should render at least 4 recall pairs, got ${answers.length}`);
    for (const answer of answers) {
      assert.match(textOf(answer), /^<cm-recall [^>]*>\n[\s\S]*\n<\/cm-recall>$/);
    }
    assert.deepEqual(
      wrapped.messages.filter(isRecallQuestion).map(textOf),
      plain.messages.filter(isRecallQuestion).map(textOf),
      'the uniform summaryContextLabel must be identical in both modes',
    );
  });

  it('sources id, level and span from the summary record', async () => {
    const wrapped = await renderHierarchicalFixture({ recallEnvelope: 'xml' });
    const byId = new Map<string, FixtureSummary>(wrapped.summaries.map((s) => [s.id, s]));

    const seen: string[] = [];
    for (const answer of recallAnswers(wrapped.messages)) {
      const attributes = parseEnvelopeAttributes(textOf(answer));
      const record = byId.get(attributes.id);
      assert.ok(record, `envelope id ${attributes.id} names no summary the strategy holds`);
      assert.equal(attributes.level, String(record.level), `level attribute for ${record.id}`);
      assert.equal(attributes.span, `${record.first}..${record.last}`, `span attribute for ${record.id}`);
      seen.push(attributes.id);
    }
    assert.deepEqual(seen, ['L2-100', 'L1-101', 'L1-102'], 'one envelope per rendered pair, in render order');
    assert.equal(byId.get('L2-100')!.level, 2, 'the fixture must exercise a merged-level recall');
  });

  it('leaves reasoning carriers byte-identical and wraps only the prose', async () => {
    const plain = await renderHierarchicalFixture();
    const wrapped = await renderHierarchicalFixture({ recallEnvelope: 'xml' });

    const carrierAnswer = wrapped.messages.find((m) => m.content.some((b) => b.type === 'thinking'));
    const plainCarrierAnswer = plain.messages.find((m) => m.content.some((b) => b.type === 'thinking'));
    assert.ok(carrierAnswer && plainCarrierAnswer, 'fixture must render an answer that replays carriers');
    assert.equal(
      JSON.stringify(carrierAnswer.content.filter((b) => b.type === 'thinking')),
      JSON.stringify(plainCarrierAnswer.content.filter((b) => b.type === 'thinking')),
      'signed thinking blocks must survive the envelope untouched',
    );
    assert.equal(carrierAnswer.content[0].type, 'thinking', 'thinking must stay first in the turn');
    assert.match(textOf(carrierAnswer), /^<cm-recall [^>]*>\nzz-memory-with-carriers\n<\/cm-recall>$/);
  });
});

describe('recallEnvelope: the delimiter is a convention, not parseable XML', () => {
  it('passes XML-significant prose through unescaped', () => {
    const summary = fakeSummary({ content: 'a < b && c > d — even a literal </cm-recall> stays verbatim' });
    const wrapped = wrapRecallAnswerContent(
      [{ type: 'text', text: summary.content }],
      summary,
      'xml',
    );
    const text = (wrapped[0] as Extract<ContentBlock, { type: 'text' }>).text;
    assert.ok(text.includes('a < b && c > d — even a literal </cm-recall> stays verbatim'));
    assert.ok(!text.includes('&lt;'), 'content must not be entity-escaped');
    assert.ok(!text.includes('&amp;'), 'content must not be entity-escaped');
  });

  it('omits an attribute the record cannot source rather than inventing one', () => {
    const noSpan = fakeSummary({ sourceRange: undefined as unknown as SummaryEntry['sourceRange'] });
    const { open } = buildRecallEnvelopeTags(noSpan);
    assert.equal(open, '<cm-recall id="L1-7" level="1">');
    assert.ok(!open.includes('span='), 'an unsourceable span must be absent, not empty');
  });

  it('does not touch content when the mode is none or unset', () => {
    const summary = fakeSummary();
    const content: ContentBlock[] = [{ type: 'text', text: 'zz-memory-body' }];
    assert.equal(wrapRecallAnswerContent(content, summary, 'none'), content);
    assert.equal(wrapRecallAnswerContent(content, summary, undefined), content);
  });
});

describe('recallEnvelope: zero-recall surgery is mode-blind', () => {
  it('removes the same minted pairs whether or not answers are enveloped', async () => {
    const results = [];
    for (const mode of ['none', 'xml'] as const) {
      const rendered = await renderAdaptiveFixture({ recallEnvelope: mode });
      const ladders = rendered.compressionRequests.filter((messages) =>
        messages.some((m) => /^\[CM\] Recall memory /.test(textOf(m))),
      );
      assert.ok(ladders.length > 0, `${mode}: fixture must mint at least one request carrying a recall ladder`);
      const request = ladders[ladders.length - 1];
      const surgery = transformZeroRecallCompression(request as never);
      results.push({
        mode,
        removed: surgery.removedRecallIds,
        original: surgery.originalMessageCount,
        sent: surgery.sentMessageCount,
      });
    }

    const [bare, enveloped] = results;
    assert.deepEqual(enveloped.removed, bare.removed, 'the same recall ids must be removed in both modes');
    assert.equal(enveloped.original, bare.original, 'both modes must present the same request shape');
    assert.equal(
      bare.original - bare.sent,
      enveloped.original - enveloped.sent,
      'identical pair-count drop in both modes',
    );
    assert.equal(bare.original - bare.sent, bare.removed.length * 2, 'each removal drops a Q and an A');
  });
});

describe('recallEnvelope: token accounting', () => {
  it('prices the actual envelope string into the recall cap, and only when enabled', () => {
    const summaries = [
      fakeSummary({ id: 'L1-11', sourceRange: { first: 'zz-msg-1', last: 'zz-msg-9' } }),
      fakeSummary({ id: 'L2-12', level: 2, sourceRange: { first: 'zz-msg-1', last: 'zz-msg-40' } }),
    ];
    const bare = new EnvelopeProbeStrategy({}).priceRecallLadder(summaries, 100_000);
    const enveloped = new EnvelopeProbeStrategy({ recallEnvelope: 'xml' })
      .priceRecallLadder(summaries, 100_000);

    assert.equal(bare.kept.length, 2, 'a generous budget keeps every summary in both modes');
    assert.equal(enveloped.kept.length, 2);
    assert.ok(
      enveloped.keptTokens > bare.keptTokens,
      `enabled mode must price higher: ${enveloped.keptTokens} !> ${bare.keptTokens}`,
    );

    const envelopeTokens = summaries.reduce(
      (total, s) => total + Math.ceil(recallEnvelopeAddedText(s, 'xml').length / 4),
      0,
    );
    assert.equal(
      enveloped.keptTokens - bare.keptTokens,
      envelopeTokens,
      'the delta must be the envelope strings themselves, not a constant',
    );
    assert.equal(recallEnvelopeAddedText(summaries[0], 'none'), '', 'disabled mode adds no characters');
  });

  it('a budget that fits bare pairs can refuse the enveloped ones', () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      fakeSummary({ id: `L1-${20 + i}`, sourceRange: { first: `zz-msg-${i}`, last: `zz-msg-${i + 1}` } }),
    );
    const bareBudget = new EnvelopeProbeStrategy({}).priceRecallLadder(summaries, 100_000).keptTokens;
    const enveloped = new EnvelopeProbeStrategy({ recallEnvelope: 'xml' })
      .priceRecallLadder(summaries, bareBudget);

    assert.ok(
      enveloped.kept.length < summaries.length,
      'at a budget sized for bare pairs, enveloped pairs must not all fit',
    );
  });
});
