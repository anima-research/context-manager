/**
 * A ladder that ends with no summary quarantines nothing when a row of its
 * span leaves the window while it waits for the quarantine ledger's lock
 * (CM #350 bot review, finding 31).
 *
 * The exhaustion path asked whether the span had left the window
 * (spanLeftWindowMidRequest) before it awaited the ledger's lock, and the
 * lock's callback checked the branch and the family again, but not the
 * span. A retraction that came while the lock was awaited, which gives the
 * row up from the chunk's record and compresses the record again over the
 * rows it keeps, still saw the old family quarantined, with an alert for a
 * chunk that is gone. The span is now asked again inside the lock.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { MessageId } from '../src/index.js';

const BASE = './test-exhaustion-span-left';
let storeSeq = 0;
function freshPath(): string {
  const path = `${BASE}-${storeSeq++}`;
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  return path;
}
after(() => {
  for (let i = 0; i < storeSeq + 1; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

/** console.error's and console.warn's calls while `fn` runs. */
async function linesDuring(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  return lines;
}

const FOLDING = {
  compressionModel: 'mock',
  targetChunkTokens: 200,
  recentWindowTokens: 300,
  headWindowTokens: 0,
  mergeThreshold: 4,
} as const;

type Chunk = { messages: Array<{ id: MessageId }> };

describe('a ladder that ends with no summary, its span leaving while it waits for the ledger lock', () => {
  it('quarantines nothing and sends no alert', async () => {
    for (const [leaves, answer] of [[true, 'empty'], [false, 'empty'], [true, 'refused'], [false, 'refused']] as const) {
      const label = `${leaves ? 'probe' : 'control'}, every answer ${answer}`;
      // Every answer is empty text, which strips to nothing (the canonical's
      // and the plain-prose retry's), or a refusal (every rung's), so the
      // ladder ends with no summary.
      const membrane = {
        complete: async () => answer === 'empty'
          ? { stopReason: 'end_turn', content: [{ type: 'text', text: '' }], usage: { input_tokens: 10, output_tokens: 1 } }
          : { stopReason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } },
      } as never;
      const strategy = new AutobiographicalStrategy(FOLDING);
      const cm = await ContextManager.open({ path: freshPath(), namespace: 'agent', strategy, membrane });
      cm.presentRows([]);
      for (let i = 0; i < 24; i++) cm.presentRows([cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`TAG${i} ` + 'word '.repeat(60))])]);

      // The span's check before the lock passes; the row leaves in the
      // microtask queued there, which runs while the exhaustion awaits the
      // ledger's lock, before the lock's callback.
      const self = strategy as unknown as { spanLeftWindowMidRequest: (chunk: Chunk) => boolean };
      const check = self.spanLeftWindowMidRequest;
      let left: MessageId | undefined;
      self.spanLeftWindowMidRequest = function (this: unknown, chunk: Chunk) {
        const gone = check.call(this, chunk);
        if (!gone && leaves && left === undefined) {
          left = chunk.messages[1]!.id;
          const row = left;
          queueMicrotask(() => { cm.retractRows([row], { undone: true }); });
        }
        return gone;
      };
      const lines = await linesDuring(async () => { await cm.tick(); });
      const status = strategy.getCompressionQuarantineStatus();
      const alerts = lines.filter((line) => line.includes('"compression:quarantine-alert"'));
      if (leaves) {
        assert.ok(left !== undefined, `${label}: premise: the row left after the check before the lock`);
        assert.equal(cm.windowStatusOf(left), 'undone', `${label}: premise: the row is out of the window`);
        assert.equal(status.count, 0, `${label}: no quarantine record was written for the chunk the row left: ${lines.join('\n')}`);
        assert.deepEqual(alerts, [], `${label}: no alert was sent`);
        assert.ok(lines.some((line) => line.includes('a row of its span left the window mid-request')), lines.join('\n'));
      } else {
        assert.ok(status.count > 0, `${label}: the ladder that ended with no summary quarantined its chunk: ${lines.join('\n')}`);
        assert.equal(alerts.length, 1, `${label}: with its alert`);
      }
      cm.close();
    }
  });
});
