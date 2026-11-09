import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager } from '../src/index.js';
import { COMBINED_RECALL_SEPARATOR_TEXT } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/index.js';
import {
  HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE,
  HIERARCHICAL_FIXTURE_PLAIN_PROSE,
  SeedableStrategy,
  renderHierarchicalFixture,
  type RenderedMessage,
} from './fixtures/recall-envelope-fixture.js';

const OMISSION_MARKER = '[content omitted: this message reached its token limit]';
const WHOLE_ENVELOPE = /<cm-recall[^>]*>\n[\s\S]*?\n<\/cm-recall>/g;

const SUMMARY_MARKER = /\[truncated — chars (\d+) to (\d+) of (\d+) elided here; the whole is stored summary (\S+?)(; [^\]]*)?\]/;

/** A summary's prose of `count` lines, 30 characters each, labelled `label`. */
const summaryLines = (label: string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${label}-${String(i).padStart(5, '0')} ${'.'.repeat(30 - label.length - 8)}\n`).join('');

function textOf(message: RenderedMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function combinedAnswerOf(messages: RenderedMessage[]): RenderedMessage {
  const answers: RenderedMessage[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].participant === 'Context Manager') answers.push(messages[i + 1]);
  }
  assert.equal(answers.length, 1, 'the combined path emits one recall answer');
  return answers[0];
}

function separators(answer: RenderedMessage): number {
  return answer.content.filter((block) => block.type === 'text' && block.text === COMBINED_RECALL_SEPARATOR_TEXT).length;
}

describe('the combined recall answer cuts each summary to maxMessageTokens on its own', () => {
  for (const mode of ['none', 'xml', 'bare'] as const) {
    it(`${mode}: a cap the first summary passes leaves every summary in the answer, the first cut and the others whole`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zz-combined-first-cut-'));
      try {
        const strategy = new SeedableStrategy({
          headWindowTokens: 0, recentWindowTokens: 8, positionedRecallPairs: false, recallEnvelope: mode, maxMessageTokens: 500,
        });
        const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
        const ids = ['zz-turn-one', 'zz-turn-two', 'zz-turn-three'].map((t) => cm.addMessage('user', [{ type: 'text', text: t }]));
        cm.addMessage('user', [{ type: 'text', text: 'zz-turn-latest ' + 'Z'.repeat(60) }]);
        const long = summaryLines('zzl', 300);
        const proses = [long, 'zz-memory-two', 'zz-memory-three'];
        ids.forEach((id, i) => strategy.seedSummary({ id: `L1-${i}`, level: 1, content: proses[i]!, tokens: Math.ceil(proses[i]!.length / 4), sourceLevel: 0, sourceIds: [id], sourceRange: { first: id, last: id } }));
        const compiled = await cm.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        const answer = combinedAnswerOf(compiled.messages as RenderedMessage[]);
        const text = textOf(answer);
        assert.equal(separators(answer), 2, 'three summaries, joined by two separators');
        assert.ok(!text.includes(long), 'the 2,250-token first summary is cut at 500');
        assert.match(text, SUMMARY_MARKER);
        const two = text.indexOf('zz-memory-two');
        const three = text.indexOf('zz-memory-three');
        assert.ok(two > 0 && three > two, `both later summaries whole, in order: ${JSON.stringify(text.slice(-300))}`);
        assert.ok(!text.includes(OMISSION_MARKER), 'no summary is left out');
        if (mode !== 'none') assert.equal(text.match(WHOLE_ENVELOPE)?.length, 3, 'each summary in its own whole envelope');
        await cm.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${mode}: a cap smaller than the marker sends each summary no longer than its marker whole, so every one is listed`, async () => {
      const rendered = await renderHierarchicalFixture({ positionedRecallPairs: false, maxMessageTokens: 1, recallEnvelope: mode });
      const text = textOf(combinedAnswerOf(rendered.messages));
      assert.ok(text.includes(HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE) && text.includes(HIERARCHICAL_FIXTURE_PLAIN_PROSE), 'the summaries whole');
      assert.doesNotMatch(text, SUMMARY_MARKER, 'none cut');
    });

    it(`${mode}: a cap smaller than the marker leaves a longer summary as its marker alone, so it is listed nowhere and the compile refuses`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zz-combined-marker-alone-'));
      try {
        const strategy = new SeedableStrategy({
          headWindowTokens: 0, recentWindowTokens: 8, positionedRecallPairs: false, recallEnvelope: mode, maxMessageTokens: 5,
        });
        const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
        const ids = ['zz-turn-one', 'zz-turn-two'].map((t) => cm.addMessage('user', [{ type: 'text', text: t }]));
        cm.addMessage('user', [{ type: 'text', text: 'zz-turn-latest ' + 'Z'.repeat(60) }]);
        ids.forEach((id, i) => {
          const prose = summaryLines(`zz${i}`, 300);
          strategy.seedSummary({ id: `L1-${i}`, level: 1, content: prose, tokens: Math.ceil(prose.length / 4), sourceLevel: 0, sourceIds: [id], sourceRange: { first: id, last: id } });
        });
        await assert.rejects(
          cm.compile({ maxTokens: 100_000, reserveForResponse: 0 }),
          (err: Error) => err.name === 'UncoveredDropError' && err.message.includes('covered-by-unemitted-summary'),
        );
        await cm.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('a cap smaller than the envelope and the marker', () => {
  it('positioned, xml: leaves a summary longer than its marker as that marker alone, inside intact tags, listed whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz-positioned-marker-alone-'));
    try {
      const strategy = new SeedableStrategy({
        headWindowTokens: 0, recentWindowTokens: 8, positionedRecallPairs: true, recallEnvelope: 'xml', maxMessageTokens: 1,
      });
      const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
      const a = cm.addMessage('user', [{ type: 'text', text: 'zz-turn-one' }]);
      cm.addMessage('user', [{ type: 'text', text: 'zz-turn-latest ' + 'Z'.repeat(60) }]);
      const prose = summaryLines('zza', 300);
      strategy.seedSummary({ id: 'L1-a', level: 1, content: prose, tokens: Math.ceil(prose.length / 4), sourceLevel: 0, sourceIds: [a], sourceRange: { first: a, last: a } });
      const compiled = await cm.compile({ maxTokens: 100_000, reserveForResponse: 0 });
      const answers = (compiled.messages as RenderedMessage[]).filter((m, i, all) => i > 0 && all[i - 1]!.participant === 'Context Manager');
      assert.equal(answers.length, 1, 'one recall pair');
      assert.match(textOf(answers[0]!), new RegExp(`^<cm-recall[^>]*>\\n\\[truncated — chars 0 to ${prose.length} of ${prose.length} elided here; the whole is stored summary L1-a\\]\\n</cm-recall>$`));
      await cm.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Renders the combined answer without one summary, as a subclass of the strategy could. */
class LeavesOutTheMiddleSummary extends SeedableStrategy {
  protected override renderCombinedRecallAnswer(summaries: SummaryEntry[], maxTokens: number) {
    return super.renderCombinedRecallAnswer(summaries.filter((s) => s.id !== 'L1-101'), maxTokens);
  }
}

describe('the coverage check counts only the summaries the combined answer holds', () => {
  it('refuses a compile whose combined answer leaves a summary out', async () => {
    await assert.rejects(
      renderHierarchicalFixture({ positionedRecallPairs: false }, LeavesOutTheMiddleSummary),
      (err: Error) => err.name === 'UncoveredDropError' && err.message.includes('covered-by-unemitted-summary'),
    );
  });
});

describe('every recall answer cuts each summary head and tail, its marker naming the summary', () => {
  for (const positionedRecallPairs of [true, false]) {
    for (const mode of ['none', 'xml', 'bare'] as const) {
      it(`${positionedRecallPairs ? 'positioned' : 'combined'}, ${mode}: each long summary keeps its head and tail, and its elided characters page by its id`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zz-recall-head-tail-'));
        try {
          const strategy = new SeedableStrategy({
            headWindowTokens: 0, recentWindowTokens: 8, positionedRecallPairs, recallEnvelope: mode, maxMessageTokens: 1_000,
          });
          const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
          const a = cm.addMessage('user', [{ type: 'text', text: 'zz-turn-one' }]);
          const b = cm.addMessage('user', [{ type: 'text', text: 'zz-turn-two' }]);
          cm.addMessage('user', [{ type: 'text', text: 'zz-turn-latest ' + 'Z'.repeat(60) }]);
          const proseA = summaryLines('zza', 1000);
          const proseB = summaryLines('zzb', 1000);
          strategy.seedSummary({ id: 'L1-a', level: 1, content: proseA, tokens: 7_500, sourceLevel: 0, sourceIds: [a], sourceRange: { first: a, last: a } });
          strategy.seedSummary({ id: 'L1-b', level: 1, content: proseB, tokens: 7_500, sourceLevel: 0, sourceIds: [b], sourceRange: { first: b, last: b } });
          const compiled = await cm.compile({ maxTokens: 100_000, reserveForResponse: 0 });
          const sent = compiled.messages.map((m) => textOf(m)).join('\n');
          for (const [id, prose, label] of [['L1-a', proseA, 'zza'], ['L1-b', proseB, 'zzb']] as const) {
            const markers = [...sent.matchAll(new RegExp(SUMMARY_MARKER.source, 'g'))].filter((m) => m[4] === id);
            assert.equal(markers.length, 1, `one marker names ${id}: ${JSON.stringify(sent.slice(0, 300))}`);
            const [, head, tailStart, total] = markers[0]!.map(Number);
            assert.equal(total, prose.length);
            assert.equal(cm.capMeasuredText({ id }), prose, "the reader pages the summary's answer prose");
            assert.ok(sent.includes(prose.slice(0, head!)), `${id}'s head is sent`);
            assert.ok(sent.includes(prose.slice(tailStart!)), `${id}'s tail is sent`);
            assert.ok(sent.includes(`${label}-00999`), `${id}'s last line is sent`);
            assert.ok(!sent.includes(prose.slice(head!, tailStart!)), `${id}'s middle is not`);
            if (mode !== 'none') {
              const envelope = [...sent.matchAll(/<cm-recall[^>]*>\n[\s\S]*?\n<\/cm-recall>/g)].find((m) => m[0].includes(`${label}-00000`));
              assert.ok(envelope && envelope[0].includes(markers[0]![0]) && envelope[0].includes(`${label}-00999`),
                `${id}'s head, marker and tail sit inside its one whole envelope`);
            }
          }
          await cm.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

describe('a summary whose head and tail hold nothing', () => {
  it('is listed nowhere, so the compile that would send it refuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz-combined-blank-ends-'));
    try {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8, positionedRecallPairs: false, maxMessageTokens: 200 });
      const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
      const a = cm.addMessage('user', [{ type: 'text', text: 'zz-turn-one' }]);
      const b = cm.addMessage('user', [{ type: 'text', text: 'zz-turn-two' }]);
      cm.addMessage('user', [{ type: 'text', text: 'zz-turn-latest ' + 'Z'.repeat(60) }]);
      // A's prose is blank at both ends, and past the cap without its blank blocks
      // too, so its head and tail hold nothing and its marker stands alone.
      strategy.seedSummary({ id: 'L1-a', level: 1, content: 'the middle of A', tokens: 3_425, sourceLevel: 0, sourceIds: [a], sourceRange: { first: a, last: a },
        responseContent: [{ type: 'text', text: ' '.repeat(6_000) }, { type: 'text', text: 'the middle of A. '.repeat(100) }, { type: 'text', text: ' '.repeat(6_000) }] });
      strategy.seedSummary({ id: 'L1-b', level: 1, content: 'zz-memory-b', tokens: 3, sourceLevel: 0, sourceIds: [b], sourceRange: { first: b, last: b } });
      await assert.rejects(
        cm.compile({ maxTokens: 100_000, reserveForResponse: 0 }),
        (err: Error & { droppedIds?: readonly string[] }) => {
          assert.equal(err.name, 'UncoveredDropError');
          assert.ok(err.message.includes('covered-by-unemitted-summary'), err.message);
          assert.deepEqual(err.droppedIds, [a], "the history left uncovered is A's");
          return true;
        },
      );
      cm.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
