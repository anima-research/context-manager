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
const TRUNCATION_MARKER = /\[truncated — original was \d+ tokens\]/;
const WHOLE_ENVELOPE = /<cm-recall[^>]*>\n[\s\S]*?\n<\/cm-recall>/g;
const CARRIER_PROSE = 'zz-memory-with-carriers';

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
      const rendered = await renderHierarchicalFixture({ positionedRecallPairs: false, maxMessageTokens: 12, recallEnvelope: mode });
      const answer = combinedAnswerOf(rendered.messages);
      const text = textOf(answer);
      assert.equal(separators(answer), 2, 'three summaries, joined by two separators');
      assert.ok(!text.includes(HIERARCHICAL_FIXTURE_MERGED_LEVEL_PROSE), 'the 13-token first summary is cut at 12');
      assert.match(text, TRUNCATION_MARKER);
      const plain = text.indexOf(HIERARCHICAL_FIXTURE_PLAIN_PROSE);
      const carriers = text.indexOf(CARRIER_PROSE);
      assert.ok(plain > 0 && carriers > plain, `both later summaries whole, in order: ${JSON.stringify(text)}`);
      assert.ok(!text.includes(OMISSION_MARKER), 'no summary is left out');
      if (mode !== 'none') assert.equal(text.match(WHOLE_ENVELOPE)?.length, 3, 'each summary in its own whole envelope');
    });

    it(`${mode}: a cap of 1 cuts every summary on its own and still leaves each in the answer`, async () => {
      const rendered = await renderHierarchicalFixture({ positionedRecallPairs: false, maxMessageTokens: 1, recallEnvelope: mode });
      const answer = combinedAnswerOf(rendered.messages);
      assert.equal(separators(answer), 2, 'three summaries, joined by two separators');
      if (mode !== 'none') assert.equal(textOf(answer).match(WHOLE_ENVELOPE)?.length, 3, 'each summary in its own whole envelope');
    });
  }
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

describe('a summary whose own cut leaves nothing of it that holds anything', () => {
  it('is listed nowhere, so the compile that would send it refuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz-combined-blank-'));
    try {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8, positionedRecallPairs: false, maxMessageTokens: 50 });
      const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
      const a = cm.addMessage('user', [{ type: 'text', text: 'zz-turn-one' }]);
      const b = cm.addMessage('user', [{ type: 'text', text: 'zz-turn-two' }]);
      cm.addMessage('user', [{ type: 'text', text: 'zz-turn-latest ' + 'Z'.repeat(60) }]);
      // A's leading blank block spends its cap of 50 tokens, 200 characters, so its text is cut away.
      strategy.seedSummary({ id: 'L1-a', level: 1, content: 'the rest of A', tokens: 54, sourceLevel: 0, sourceIds: [a], sourceRange: { first: a, last: a },
        responseContent: [{ type: 'text', text: ' '.repeat(200) }, { type: 'text', text: 'the rest of A' }] });
      strategy.seedSummary({ id: 'L1-b', level: 1, content: 'zz-memory-b', tokens: 3, sourceLevel: 0, sourceIds: [b], sourceRange: { first: b, last: b } });
      await assert.rejects(
        cm.compile({ maxTokens: 100_000, reserveForResponse: 0 }),
        (err: Error & { droppedIds?: readonly string[] }) => {
          assert.equal(err.name, 'UncoveredDropError');
          assert.ok(err.message.includes('covered-by-unemitted-summary'), err.message);
          assert.deepEqual(err.droppedIds, [a], 'the history left uncovered is A\'s, the summary its own cut left nothing of');
          return true;
        },
      );
      cm.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
