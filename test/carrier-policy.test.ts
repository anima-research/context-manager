/**
 * `carrierPolicy` — where a summary's captured reasoning carriers replay.
 *
 * A summary's `responseContent` carries the ARCHIVIST'S cognition: signed
 * `thinking` / `redacted_thinking` blocks from the request that WROTE the
 * memory. They ride two surfaces, and the two want different things:
 *
 *  - mint/merge recall pairs — carriers are measured load-bearing there
 *    (2026-07-16: text-only recall refused, carrier-bearing recall passed), so
 *    no policy value may strip them;
 *  - the live window — where the agent reads its own memory back, and a
 *    thinking block is inhabited rather than read.
 *
 * `'live-strip'` therefore cuts exactly one surface, by OMITTING WHOLE BLOCKS:
 * signatures verify only on byte-identical blocks, so the mint side must find
 * its carriers unchanged after the live side dropped them. Both directions are
 * pinned here on the SAME memory.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { CarrierPolicy, SummaryEntry } from '../src/types/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-carrier-policy';
const ZZ_COMPRESSION_MODEL = 'zz-compression-model';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

interface CapturedRequest {
  messages: Array<{ participant: string; content: Array<Record<string, unknown>> }>;
}

/**
 * Membrane stub: every response carries a signed thinking block, a redacted
 * carrier and prose, and every request it is handed is captured verbatim.
 */
function makeCarrierMembrane() {
  let calls = 0;
  const requests: CapturedRequest[] = [];
  return {
    requests,
    callCount: () => calls,
    complete: async (request: CapturedRequest) => {
      calls++;
      requests.push(JSON.parse(JSON.stringify(request)) as CapturedRequest);
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'thinking',
            thinking: `zz-archivist-scratch for mint ${calls}`,
            signature: `zz-sig-${calls}-fedcba9876543210`,
          },
          { type: 'redacted_thinking', data: `zz-enc-${calls}-payload==` },
          { type: 'text', text: `zz-memory-${calls}: the ite1 stretch, as I remember it.` },
        ],
        usage: { inputTokens: 400, outputTokens: 90 },
      };
    },
  };
}

function strategyConfig(carrierPolicy?: CarrierPolicy) {
  return {
    compressionModel: ZZ_COMPRESSION_MODEL,
    targetChunkTokens: 50,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    summaryParticipant: 'Claude',
    ...(carrierPolicy ? { carrierPolicy } : {}),
  } as const;
}

const filler = (n: number) => 'zz-word '.repeat(n);

/** Mint one L1 with carriers, then a second chunk whose compression request
 *  recalls it. Returns the first L1, the live window, and the mint requests. */
async function runTwoChunks(carrierPolicy?: CarrierPolicy) {
  cleanup();
  const membrane = makeCarrierMembrane();
  const strategy = new AutobiographicalStrategy(strategyConfig(carrierPolicy));
  const manager = await ContextManager.open({
    path: TEST_STORE_PATH,
    strategy,
    membrane: membrane as never,
  });

  for (let i = 0; i < 8; i++) {
    manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: filler(30) }]);
  }
  await manager.compile();
  await manager.tick();

  for (let i = 0; i < 8; i++) {
    manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: filler(30) }]);
  }
  const liveWindow = await manager.compile();
  await manager.tick();

  const summaries = (strategy as unknown as { summaries: SummaryEntry[] }).summaries;
  const firstL1 = summaries.filter((e) => e.level === 1)[0];
  await manager.close();
  return { strategy, firstL1, liveWindow, requests: membrane.requests };
}

function summaryAnswerTurns(
  messages: ReadonlyArray<{ participant: string; content: ContentBlock[] }>,
) {
  return messages.filter(
    (m) =>
      m.participant === 'Claude' &&
      m.content.some(
        (b) => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('zz-memory-'),
      ),
  );
}

function findMintRecallAnswer(requests: CapturedRequest[], signature: string) {
  for (const request of requests) {
    for (const message of request.messages) {
      if (message.content.some((b) => b.type === 'thinking' && b.signature === signature)) {
        return message;
      }
    }
  }
  return undefined;
}

describe('carrierPolicy', () => {
  before(() => cleanup());
  after(() => cleanup());

  it("defaults to 'full': the live window replays carriers verbatim", async () => {
    const { firstL1, liveWindow } = await runTwoChunks();

    assert.ok(firstL1?.responseContent, 'setup: the first L1 captured carriers');
    const answers = summaryAnswerTurns(liveWindow.messages);
    assert.ok(answers.length >= 1, 'setup: the live window renders a summary answer');
    const answer = answers[0]!;
    assert.deepStrictEqual(
      answer.content.map((b) => b.type),
      ['thinking', 'redacted_thinking', 'text'],
      'default render is the stored blocks in provider order',
    );
    assert.deepStrictEqual(
      answer.content,
      firstL1!.responseContent,
      'default render is byte-identical to the stored response content',
    );
  });

  it("'live-strip' renders the live window with zero carrier blocks", async () => {
    const { firstL1, liveWindow } = await runTwoChunks('live-strip');

    assert.ok(firstL1?.responseContent, 'setup: the first L1 captured carriers');
    const answers = summaryAnswerTurns(liveWindow.messages);
    assert.ok(answers.length >= 1, 'setup: the live window renders a summary answer');
    for (const answer of answers) {
      assert.deepStrictEqual(
        answer.content.map((b) => b.type),
        ['text'],
        'carriers omitted whole; prose survives',
      );
    }
    const carrierLeak = liveWindow.messages.some((m) =>
      m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
    );
    assert.strictEqual(carrierLeak, false, 'no carrier block anywhere in the live window');
    assert.ok(
      answers[0]!.content.some(
        (b) => b.type === 'text' && b.text.includes('as I remember it'),
      ),
      'the memory prose is still what the agent reads',
    );
  });

  it("'live-strip' leaves the SAME memory's mint-side recall byte-verbatim", async () => {
    const { firstL1, requests } = await runTwoChunks('live-strip');

    assert.ok(firstL1?.responseContent, 'setup: the first L1 captured carriers');
    const storedSignature = (firstL1!.responseContent![0] as { signature?: string }).signature;
    assert.ok(storedSignature, 'setup: the stored carrier is signed');

    const recallAnswer = findMintRecallAnswer(requests, storedSignature!);
    assert.ok(recallAnswer, 'a later mint request recalls the memory WITH its carrier');
    assert.deepStrictEqual(
      recallAnswer!.content,
      JSON.parse(JSON.stringify(firstL1!.responseContent)),
      'mint-side recall replays the stored blocks byte-for-byte, signature fields intact',
    );
  });

  it("'full' and 'live-strip' agree on the mint surface", async () => {
    const full = await runTwoChunks();
    const stripped = await runTwoChunks('live-strip');

    const fullSignature = (full.firstL1!.responseContent![0] as { signature?: string }).signature!;
    const strippedSignature = (stripped.firstL1!.responseContent![0] as { signature?: string })
      .signature!;
    assert.strictEqual(fullSignature, strippedSignature, 'setup: the two runs mint alike');

    const fullRecall = findMintRecallAnswer(full.requests, fullSignature);
    const strippedRecall = findMintRecallAnswer(stripped.requests, strippedSignature);
    assert.ok(fullRecall && strippedRecall, 'both runs recall the memory on the mint surface');
    assert.deepStrictEqual(
      strippedRecall!.content,
      fullRecall!.content,
      'the policy changes nothing about what the summarizer is shown',
    );
  });

  it('prices a recall pair for the live render it will actually emit', async () => {
    const carrierEntry: SummaryEntry = {
      id: 'zz-sum-1',
      level: 1,
      content: 'zz-memory prose for the ite1 stretch.',
      tokens: 40,
      sourceIds: ['zz-msg-1'],
      sourceRange: { first: 'zz-msg-1', last: 'zz-msg-2' },
      sourceLevel: 0,
      timestamp: 0,
      responseContent: [
        {
          type: 'thinking',
          thinking: 'zz-archivist-scratch '.repeat(200),
          signature: 'zz-sig-1-fedcba9876543210',
        },
        { type: 'text', text: 'zz-memory prose for the ite1 stretch.' },
      ],
    } as unknown as SummaryEntry;

    const priceUnder = (carrierPolicy?: CarrierPolicy) => {
      const strategy = new AutobiographicalStrategy(strategyConfig(carrierPolicy));
      const reach = strategy as unknown as { recallPairCost(s: SummaryEntry): number };
      return reach.recallPairCost(carrierEntry);
    };

    const fullCost = priceUnder();
    const strippedCost = priceUnder('live-strip');
    assert.ok(
      strippedCost < fullCost,
      `stripped pair prices below the carrier-bearing one (${strippedCost} < ${fullCost})`,
    );
    assert.ok(
      fullCost - strippedCost > 500,
      'the difference is the carrier itself, not rounding',
    );
  });

  it("'live-strip' falls back to prose when an entry is carrier-only", async () => {
    const carrierOnlyEntry: SummaryEntry = {
      id: 'zz-sum-2',
      level: 1,
      content: 'zz-memory prose that only `content` carries.',
      tokens: 12,
      sourceIds: ['zz-msg-3'],
      sourceRange: { first: 'zz-msg-3', last: 'zz-msg-4' },
      sourceLevel: 0,
      timestamp: 0,
      responseContent: [{ type: 'redacted_thinking', data: 'zz-enc-only-payload==' }],
    } as unknown as SummaryEntry;

    const strategy = new AutobiographicalStrategy(strategyConfig('live-strip'));
    const reach = strategy as unknown as {
      liveWindowAnswerProse(s: SummaryEntry): ContentBlock[];
    };
    assert.deepStrictEqual(
      reach.liveWindowAnswerProse(carrierOnlyEntry),
      [{ type: 'text', text: 'zz-memory prose that only `content` carries.' }],
      'a live turn is never emitted empty',
    );
  });

  it("'live-strip' composes with the recall envelope", async () => {
    const entry: SummaryEntry = {
      id: 'zz-sum-3',
      level: 2,
      content: 'zz-memory prose under an envelope.',
      tokens: 12,
      sourceIds: ['zz-sum-1'],
      sourceRange: { first: 'zz-msg-1', last: 'zz-msg-4' },
      sourceLevel: 1,
      timestamp: 0,
      responseContent: [
        { type: 'thinking', thinking: 'zz-archivist-scratch', signature: 'zz-sig-3-aaaa' },
        { type: 'text', text: 'zz-memory prose under an envelope.' },
      ],
    } as unknown as SummaryEntry;

    const strategy = new AutobiographicalStrategy({
      ...strategyConfig('live-strip'),
      recallEnvelope: 'xml',
    });
    const reach = strategy as unknown as {
      liveWindowAnswerContent(s: SummaryEntry): ContentBlock[];
      summaryAnswerContent(s: SummaryEntry): ContentBlock[];
    };

    const live = reach.liveWindowAnswerContent(entry);
    assert.deepStrictEqual(live.map((b) => b.type), ['text'], 'live side: prose only');
    const liveText = (live[0] as { text: string }).text;
    assert.ok(liveText.startsWith('<cm-recall id="zz-sum-3"'), 'envelope opens the live answer');
    assert.ok(liveText.endsWith('</cm-recall>'), 'envelope closes the live answer');

    const mint = reach.summaryAnswerContent(entry);
    assert.deepStrictEqual(
      mint.map((b) => b.type),
      ['thinking', 'text'],
      'mint side keeps the carrier under the same envelope',
    );
    assert.deepStrictEqual(
      mint[0],
      entry.responseContent![0],
      'the enveloped mint answer never rewrites a signed block',
    );
  });
});
