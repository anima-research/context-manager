/**
 * Regression: post-strip estimates must subtract a stripped image at the
 * store's CALIBRATED price. The store prices each block as
 * round(raw × calibration); subtracting the uncalibrated 1600 drove
 * image-only messages negative whenever calibration < ~0.995, and kv-unified's
 * canonical-forest validator then rejected every compile with
 * "chunk N has invalid raw cost -…".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

function storeAt(calibration: number, messages: Array<{ id: string; content: ContentBlock[] }>) {
  const raw = (b: ContentBlock): number =>
    b.type === 'image' ? ((b as { tokenEstimate?: number }).tokenEstimate ?? 1600)
      : b.type === 'text' ? Math.ceil(b.text.length / 4) : 0;
  return {
    getAll: () => messages as any[],
    get: (id: string) => (messages.find((m) => m.id === id) as any) ?? null,
    getFrom: (i: number) => messages.slice(i) as any[],
    getTail: (n: number) => messages.slice(-n) as any[],
    length: () => messages.length,
    estimateTokens: (m: { content: ContentBlock[] }) =>
      m.content.reduce((sum, b) => sum + Math.round(raw(b) * calibration), 0),
    getTokenCalibration: () => calibration,
  };
}

/** The live-image placeholder; this view prices it at its length / 4, like any text here. */
const PLACEHOLDER = "[image not shown: this context keeps only some images]";

const image = (): ContentBlock =>
  ({ type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } }) as ContentBlock;

describe('postStripEstimates × calibration', () => {
  for (const calibration of [0.5, 0.93, 1, 1.4]) {
    it(`never goes negative and nets out the image at calibration ${calibration}`, () => {
      const strategy = new AutobiographicalStrategy({ maxLiveImages: 1 } as any);
      const messages = [
        { id: 'old', content: [image()] },                         // stripped (beyond maxLiveImages)
        { id: 'new', content: [image(), { type: 'text', text: 'hi' } as ContentBlock] }, // live
      ];
      const store = storeAt(calibration, messages);
      const pse: number[] = (strategy as any).postStripEstimates(store);
      assert.ok(pse.every((n) => Number.isFinite(n) && n >= 0), `estimates ${JSON.stringify(pse)}`);
      assert.strictEqual(pse[0], store.estimateTokens({ content: [{ type: 'text', text: PLACEHOLDER } as ContentBlock] }), `the stripped image costs its placeholder, as the store prices it: ${pse[0]}`);
      assert.strictEqual(pse[1], store.estimateTokens(messages[1]!), 'the live message costs what the store prices it at');
    });
  }
});
