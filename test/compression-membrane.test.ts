/**
 * A separate membrane for memory-writing calls (`compressionMembrane`).
 *
 * A host can send compression to another provider or credential than the
 * agent's own turns: ContextManagerConfig.compressionMembrane →
 * StrategyContext.compressionMembrane → every call the autobiographical
 * strategy makes to write memory: L1 mints, merges, the retries after a
 * refusal, the carrier-transport fallback and the transition summary. Without
 * one, every such call goes to `membrane`, as before.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock, Membrane, NormalizedRequest } from '@animalabs/membrane';

const STORE_PATH = './test-compression-membrane';
const COMPRESSION_MODEL = 'compression-membrane-model';
/** In every L1 compression instruction, in no merge prompt. */
const L1_MARKER_SNIPPET = 'You will soon form a new memory';

function cleanup(): void {
  if (existsSync(STORE_PATH)) rmSync(STORE_PATH, { recursive: true, force: true });
}

const t = (text: string): ContentBlock => ({ type: 'text', text });

type Reply = (request: NormalizedRequest, n: number) => unknown;

const ok: Reply = () => ({
  stopReason: 'end_turn',
  content: [t('A stretch of routine traffic worth remembering in some detail: ' + 'word '.repeat(40))],
  usage: { input_tokens: 1000, output_tokens: 50 },
});

function capturing(reply: Reply = ok) {
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      return reply(request, calls.length);
    },
  };
  return { membrane: membrane as unknown as Membrane, calls };
}

function isMerge(request: NormalizedRequest): boolean {
  return !request.messages.some((m) =>
    m.content.some((b) => b.type === 'text' && b.text.includes(L1_MARKER_SNIPPET)));
}

function carriesReasoning(request: NormalizedRequest): boolean {
  return request.messages.some((m) => m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

interface Workload {
  primary?: Membrane;
  compression?: Membrane;
  strategyOptions?: Record<string, unknown>;
  turns?: number;
}

async function runWorkload(w: Workload): Promise<void> {
  cleanup();
  const strategy = new AutobiographicalStrategy({
    compressionModel: COMPRESSION_MODEL,
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    mergeThreshold: 2,
    ...w.strategyOptions,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const manager = await ContextManager.open({
    path: STORE_PATH,
    strategy,
    ...(w.primary ? { membrane: w.primary } : {}),
    ...(w.compression ? { compressionMembrane: w.compression } : {}),
  });
  const turns = w.turns ?? 60;
  for (let i = 0; i < turns; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
      t(`turn ${i} of steady substantive traffic about the ongoing work `.repeat(3)),
    ]);
    await drain(manager);
  }
  await manager.close();
  cleanup();
}

describe('compressionMembrane', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('none given: every L1 mint and merge goes to membrane', async () => {
    const primary = capturing();
    await runWorkload({ primary: primary.membrane });
    assert.ok(primary.calls.filter((r) => !isMerge(r)).length >= 2, 'expected L1 mints on membrane');
    assert.ok(primary.calls.filter(isMerge).length >= 1, 'expected merges on membrane');
  });

  it('given: every L1 mint and merge goes to it, none to membrane', async () => {
    const primary = capturing();
    const compression = capturing();
    await runWorkload({ primary: primary.membrane, compression: compression.membrane });
    assert.strictEqual(primary.calls.length, 0, 'membrane must carry no memory-writing call');
    assert.ok(compression.calls.filter((r) => !isMerge(r)).length >= 2, 'expected L1 mints on compressionMembrane');
    assert.ok(compression.calls.filter(isMerge).length >= 1, 'expected merges on compressionMembrane');
  });

  it('the requests are identical whichever membrane carries them', async () => {
    const viaPrimary = capturing();
    await runWorkload({ primary: viaPrimary.membrane });
    const primary = capturing();
    const viaCompression = capturing();
    await runWorkload({ primary: primary.membrane, compression: viaCompression.membrane });
    assert.strictEqual(primary.calls.length, 0);
    assert.ok(viaPrimary.calls.length >= 3);
    assert.deepStrictEqual(viaCompression.calls, viaPrimary.calls);
  });

  it('compressionMembrane alone (no membrane): compression runs on it', async () => {
    const compression = capturing();
    await runWorkload({ compression: compression.membrane, turns: 30 });
    assert.ok(compression.calls.length > 0);
  });

  it('refusal fallbacks: every retry after a refusal goes to compressionMembrane', async () => {
    const primary = capturing();
    let refused = 0;
    const compression = capturing((request, n) => {
      if (n <= 3) {
        refused++;
        return { stopReason: 'refusal', content: [t('I cannot help with that.')], usage: { input_tokens: 10, output_tokens: 5 } };
      }
      return ok(request, n);
    });
    await runWorkload({
      primary: primary.membrane,
      compression: compression.membrane,
      strategyOptions: { compressionRefusalCurveFallbacks: 2, compressionSourceOnlyFallback: true },
    });
    assert.strictEqual(refused, 3, 'setup: the first three calls were refused');
    assert.strictEqual(primary.calls.length, 0, 'no refusal fallback may reach membrane');
    assert.ok(compression.calls.length > 3, 'compression went on, on compressionMembrane');
  });

  it('carrier-transport fallback: the stripped retry goes to compressionMembrane', async () => {
    const primary = capturing();
    let rejected = 0;
    const compression = capturing((request, n) => {
      if (carriesReasoning(request)) {
        rejected++;
        throw Object.assign(new Error('invalid_request_error: thinking blocks cannot be modified'), { type: 'invalid_request', retryable: false, httpStatus: 400 });
      }
      return {
        stopReason: 'end_turn',
        content: [
          { type: 'thinking', thinking: `scratch ${n}`, signature: `sig-${n}-0123456789abcdef` },
          t(`Summary #${n}: things happened and I remember them. ` + 'word '.repeat(30)),
        ],
        usage: { input_tokens: 500, output_tokens: 80 },
      };
    });
    await runWorkload({ primary: primary.membrane, compression: compression.membrane });
    assert.strictEqual(primary.calls.length, 0);
    assert.ok(rejected >= 1, 'setup: a request carrying reasoning reached the compression transport');
    const accepted = compression.calls.filter((r) => !carriesReasoning(r));
    assert.ok(accepted.length > rejected, 'each rejection was followed by a stripped retry on compressionMembrane');
  });

  it('transition summary (resetHeadWindow without text) goes to compressionMembrane', async () => {
    cleanup();
    const primary = capturing();
    const compression = capturing(() => ({
      stopReason: 'end_turn', content: [t('transition summary')], usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const strategy = new AutobiographicalStrategy({ compressionModel: COMPRESSION_MODEL, autoTickOnNewMessage: false });
    const manager = await ContextManager.open({
      path: STORE_PATH, strategy, membrane: primary.membrane, compressionMembrane: compression.membrane,
    });
    manager.addMessage('user', [t('what we were doing before the topic changed')]);
    const summary = await manager.resetHeadWindow();
    assert.strictEqual(summary, 'transition summary');
    assert.strictEqual(primary.calls.length, 0);
    assert.strictEqual(compression.calls.length, 1);
    await manager.close();
    cleanup();
  });

  it('derive: inherits the parent\'s compressionMembrane unless given a membrane or one of its own', async () => {
    cleanup();
    const primary = capturing();
    const compression = capturing();
    const childOwn = capturing();
    const childCompression = capturing();
    const fresh = () => new AutobiographicalStrategy({ compressionModel: COMPRESSION_MODEL, autoTickOnNewMessage: false });
    const parent = await ContextManager.open({
      path: STORE_PATH, strategy: fresh(), membrane: primary.membrane, compressionMembrane: compression.membrane,
    });
    parent.addMessage('user', [t('something to derive from')]);
    const inherits = await parent.derive({ branch: 'cm/inherits', strategy: fresh() });
    assert.strictEqual(inherits.getCompressionMembrane(), compression.membrane);
    const ownMembrane = await parent.derive({ branch: 'cm/own-membrane', strategy: fresh(), membrane: childOwn.membrane });
    assert.strictEqual(ownMembrane.getCompressionMembrane(), undefined,
      'a membrane given for the child carries its compression too, as before');
    const ownCompression = await parent.derive({
      branch: 'cm/own-compression', strategy: fresh(), membrane: childOwn.membrane, compressionMembrane: childCompression.membrane,
    });
    assert.strictEqual(ownCompression.getCompressionMembrane(), childCompression.membrane);
    for (const m of [ownCompression, ownMembrane, inherits]) await m.close();
    await parent.close();
    cleanup();
  });
});
