/**
 * Regression: the L1 mint builder capped compression-image bytes on
 * `llmMessages` — the PRE-split list — while the wire messages are derived
 * from `cleaned` (splitMixedToolMessages → collapse → stripUnpairedToolBlocks),
 * which REBUILDS message objects. The cap therefore logged its strips against
 * copies the request never shipped: a mixed tool round carrying an image kept
 * its image on the wire under ANY budget.
 *
 * Field repro (2026-09-21, text-only model on an OpenAI-compatible gateway):
 * "[autobiographical] compression prompt: replaced 1 older image(s) ...
 * (kept 0MB)" logged, and the same mint still failed with
 * 400 image_input_not_supported. The merge builder has always capped its
 * post-split list; the fix aligns the L1 builder with it.
 *
 * These tests drive real mints through a capturing membrane and assert on the
 * bytes that would actually ship.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { ContextManager } from '../src/context-manager.js';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-compression-image-cap-wire';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

const t = (text: string): ContentBlock => ({ type: 'text', text });

// Big enough that a 1-byte budget can never admit it.
const PNG_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'.repeat(4);
const image = (): ContentBlock =>
  ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PNG_DATA } } as ContentBlock);

/** Every image block in a request, including those nested in tool_results. */
function imageBlocks(request: NormalizedRequest): ContentBlock[] {
  const found: ContentBlock[] = [];
  const walk = (blocks: ContentBlock[]): void => {
    for (const b of blocks) {
      if (b.type === 'image') found.push(b);
      const nested = (b as { content?: unknown }).content;
      if (b.type === 'tool_result' && Array.isArray(nested)) walk(nested as ContentBlock[]);
    }
  };
  for (const m of request.messages) walk(m.content as ContentBlock[]);
  return found;
}

function createCapturingMembrane() {
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(request);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'A stretch of routine traffic worth remembering: ' + 'word '.repeat(40) }],
        usage: { input_tokens: 1000, output_tokens: 50 },
      };
    },
  };
  return { membrane, calls };
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

async function runWorkload(maxCompressionImageBytes: number): Promise<NormalizedRequest[]> {
  cleanup();
  const { membrane, calls } = createCapturingMembrane();
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    maxCompressionImageBytes,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const manager = await ContextManager.open({
    path: TEST_STORE_PATH,
    strategy,
    membrane: membrane as never,
  });
  // Chunks carrying tool blocks defer compression until the host has pushed
  // tool definitions (see the defer guard in the mint builder) — a real host
  // pushes them on every activation; do the same here or the tool-round chunk
  // stalls the whole queue.
  manager.setToolDefinitions([
    { name: 'render_plot', description: 'renders a plot', inputSchema: { type: 'object', properties: {} } },
  ]);
  for (let i = 0; i < 40; i++) {
    if (i === 3) {
      // A MIXED tool round: tool_use and its tool_result (image inside) in one
      // agent message. splitMixedToolMessages rebuilds this into separate
      // API-shape messages — the exact path where a pre-split cap loses its
      // strips. A top-level user image rides along two turns later.
      manager.addMessage('agent', [
        t('let me look at the plot'),
        { type: 'tool_use', id: 'tu_1', name: 'render_plot', input: {} } as ContentBlock,
        { type: 'tool_result', toolUseId: 'tu_1', content: [t('rendered:'), image()] } as unknown as ContentBlock,
      ]);
    } else if (i === 5) {
      manager.addMessage('user', [t('here is a screenshot'), image()]);
    } else {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
        t(`turn ${i} of steady substantive traffic about the ongoing work `.repeat(3)),
      ]);
    }
    await drain(manager);
  }
  await manager.close();
  return calls;
}

describe('compression prompt image cap applies to the WIRE messages', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('a 1-byte budget ships zero image blocks — including images inside split tool rounds', async () => {
    const calls = await runWorkload(1);
    assert.ok(calls.length >= 2, `expected mints to fire, got ${calls.length}`);
    for (const request of calls) {
      const imgs = imageBlocks(request);
      assert.equal(
        imgs.length,
        0,
        `request shipped ${imgs.length} image block(s) under a 1-byte budget`,
      );
    }
  });

  it('a roomy budget keeps the images (the cap did not become a blanket strip)', async () => {
    const calls = await runWorkload(20_000_000);
    const withImages = calls.filter((r) => imageBlocks(r).length > 0);
    assert.ok(
      withImages.length >= 1,
      'expected at least one mint to carry the chunk images under a 20MB budget',
    );
  });
});
