/**
 * Tests for the live-image policy in AutobiographicalStrategy:
 *
 *   (1) maxLiveImages — a hard count ceiling. Only the N most-recent images
 *       survive as real image blocks; older ones become text placeholders.
 *   (2) imageStripDepthTokens — a depth cutoff. Images deeper than D tokens
 *       from the newest message are stripped even though the surrounding text
 *       stays verbatim (so text horizon >> image horizon).
 *
 * Stripped images are replaced by "[image dropped from live context]".
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-image-stripping';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

/** A message carrying one image plus a text label so we can locate it later. */
function imageMessage(label: string, tokenEstimate = 1600): ContentBlock[] {
  return [
    { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' }, tokenEstimate } as ContentBlock,
    { type: 'text', text: label },
  ];
}

/** Find the compiled entry whose text contains `label`, and report whether it
 *  still holds a real image block or was reduced to the placeholder. */
function imageState(messages: { content: ContentBlock[] }[], label: string): 'image' | 'stripped' | 'missing' {
  const entry = messages.find((m) =>
    m.content.some((b) => b.type === 'text' && b.text.includes(label)),
  );
  if (!entry) return 'missing';
  if (entry.content.some((b) => b.type === 'image')) return 'image';
  if (entry.content.some((b) => b.type === 'text' && b.text.includes('image dropped from live context')))
    return 'stripped';
  return 'missing';
}

describe('Live image policy', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('keeps only the maxLiveImages most-recent images (count cap)', async () => {
    cleanup();
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 1_000_000, // keep everything verbatim
      hierarchical: true,
      maxLiveImages: 2,
      imageStripDepthTokens: 0, // disable depth strip — isolate the count cap
    });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-0${i}`));

    const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });

    // Newest two (img-03, img-04) keep their image; older two are stripped.
    assert.equal(imageState(compiled.messages, 'img-04'), 'image', 'newest image kept');
    assert.equal(imageState(compiled.messages, 'img-03'), 'image', '2nd-newest image kept');
    assert.equal(imageState(compiled.messages, 'img-02'), 'stripped', '3rd-newest stripped by count cap');
    assert.equal(imageState(compiled.messages, 'img-01'), 'stripped', 'oldest stripped by count cap');

    manager.close();
  });

  it('strips images deeper than imageStripDepthTokens (depth cutoff)', async () => {
    cleanup();
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 1_000_000, // text horizon stays huge
      hierarchical: true,
      maxLiveImages: 0, // unlimited count — isolate the depth cutoff
      imageStripDepthTokens: 3500, // ~2 images (1600 each) fit within the window
    });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-0${i}`));

    const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });

    // Newest fits inside the depth window; the oldest is well beyond it.
    assert.equal(imageState(compiled.messages, 'img-04'), 'image', 'newest image within depth window');
    assert.equal(imageState(compiled.messages, 'img-01'), 'stripped', 'oldest image beyond depth window');

    // But the text of the stripped message is still present verbatim (text
    // horizon is independent of the image horizon).
    const oldestText = compiled.messages.find((m) =>
      m.content.some((b) => b.type === 'text' && b.text.includes('img-01')),
    );
    assert.ok(oldestText, 'oldest message text survives even though its image was stripped');

    manager.close();
  });

  it('leaves images untouched when the policy is disabled', async () => {
    cleanup();
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 1_000_000,
      hierarchical: true,
      maxLiveImages: 0,
      imageStripDepthTokens: 0,
    });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });

    for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-0${i}`));

    const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });

    for (const label of ['img-01', 'img-02', 'img-03']) {
      assert.equal(imageState(compiled.messages, label), 'image', `${label} kept when policy disabled`);
    }

    manager.close();
  });
});
