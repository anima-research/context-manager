/**
 * Mint requests must carry the host's live system prompt (opt-in).
 *
 * A mint request is deliberately built as-of the span it compresses — same
 * head, same recall ladder, no tail after the chunk. One identity layer was
 * structurally missing from it: the system prompt the host serves the live
 * agent on every activation never reached the mint at all. On hosts whose
 * identity and conduct live in system voice, every memory was therefore
 * authored by a system-promptless variant of the agent — and merges
 * re-summarize summaries, so the drift compounded upward through the pyramid.
 *
 * What the threading supplies is the host's CURRENT prompt, not a historical
 * one. ContextManager keeps it in a single slot that setSystemPrompt
 * overwrites, never a per-message history, so a mint is served the identity
 * policy in force AT MINT TIME. That equals what the original instance was
 * served exactly insofar as the host keeps the prompt stable across the
 * compressed span; where it has changed, the memory is authored under the
 * current policy and the older text is not recoverable from here. See
 * ContextManager.setSystemPrompt.
 *
 * The fix mirrors the tool-definition precedent: ContextManager
 * .setSystemPrompt(text) -> StrategyContext.systemPrompt -> the `system`
 * field of BOTH mint request families (L1 chunk compression and level
 * merges), served ahead of the identity head exactly as a live activation
 * serves it. KnowledgeStrategy inherits both builders unchanged.
 *
 * Opt-in means opt-in: with the setter never called, a mint request carries
 * no `system` key at all, so its canonical hash and quarantine identity are
 * byte-identical to the pre-threading shape.
 *
 * What the cases below pin, and what they do not. Five pin the THREADING:
 * that both mint families carry the set prompt, that it leads the request
 * rather than being spliced into the replayed messages, that an undeclared
 * host leaves the pre-threading request shape untouched, and that
 * KnowledgeStrategy inherits it. One pins the SLOT — 'an empty or undefined
 * later call never downgrades a recorded prompt' — which is last-value-wins
 * behaviour, not history: it asserts that a later push replaces the recorded
 * value and that an empty push does not blank it. No case here asserts that a
 * mint receives the prompt that was in force during the span it compresses,
 * because the mechanism does not retain one.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import {
  ContextManager,
  AutobiographicalStrategy,
  KnowledgeStrategy,
} from '../src/index.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const ZZ_STORE_PATH = './test-zz-mint-system-prompt';
const ZZ_COMPRESSION_MODEL = 'zz-mint-compression-model';

/**
 * Deliberately unmistakable as a fixture, and unique enough that finding it
 * inside a captured request proves it came from the setter and nowhere else.
 */
const ZZ_SYSTEM_PROMPT =
  'You are zz-archivist, a fictional agent whose whole conduct lives in ' +
  'system voice. Speak plainly and never invent a zz-quorum.';

/** Present in every L1 compression instruction, absent from merge prompts. */
const L1_MARKER_SNIPPET = 'You will soon form a new memory';

function cleanup(): void {
  if (existsSync(ZZ_STORE_PATH)) {
    rmSync(ZZ_STORE_PATH, { recursive: true, force: true });
  }
}

const t = (text: string): ContentBlock => ({ type: 'text', text });

function createCapturingMembrane() {
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(request);
      const summary =
        'A stretch of routine traffic worth remembering in some detail: ' +
        'word '.repeat(40);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: summary }],
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

function isMerge(request: NormalizedRequest): boolean {
  return !request.messages.some((m) =>
    m.content.some((b) => b.type === 'text' && b.text.includes(L1_MARKER_SNIPPET)));
}

function isL1(request: NormalizedRequest): boolean {
  return !isMerge(request);
}

interface WorkloadOptions {
  /** Passed to setSystemPrompt before any mint can run; omitted = never called. */
  systemPrompt?: string;
  /** Extra setSystemPrompt calls made after the first, in order. */
  laterSystemPrompts?: Array<string | undefined>;
  knowledge?: boolean;
  turns?: number;
  strategyOptions?: Record<string, unknown>;
  /**
   * Drain once at the end instead of after every turn. KnowledgeStrategy
   * recomputes its semantic chunk boundaries on every rebuild, so a
   * drain-per-turn workload trips its overlap guard repeatedly and floods
   * the run with warnings that have nothing to do with what is under test.
   */
  drainAtEnd?: boolean;
}

async function runWorkload(options: WorkloadOptions = {}): Promise<NormalizedRequest[]> {
  cleanup();
  const { membrane, calls } = createCapturingMembrane();
  const strategyOptions = {
    compressionModel: ZZ_COMPRESSION_MODEL,
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    ...options.strategyOptions,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0];
  const strategy = options.knowledge
    ? new KnowledgeStrategy(strategyOptions)
    : new AutobiographicalStrategy(strategyOptions);
  const manager = await ContextManager.open({
    path: ZZ_STORE_PATH,
    strategy,
    membrane: membrane as any,
  });
  if (options.systemPrompt !== undefined) manager.setSystemPrompt(options.systemPrompt);
  for (const later of options.laterSystemPrompts ?? []) manager.setSystemPrompt(later);

  const turns = options.turns ?? 40;
  for (let i = 0; i < turns; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
      t(`turn ${i} of steady substantive traffic about the ongoing work `.repeat(3)),
    ]);
    if (!options.drainAtEnd) await drain(manager);
  }
  if (options.drainAtEnd) {
    await manager.compile();
    await drain(manager);
  }
  await manager.close();
  cleanup();
  return calls;
}

describe('Mint requests: the host system prompt', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('L1 mint requests carry the set prompt as the request system field', async () => {
    const calls = await runWorkload({ systemPrompt: ZZ_SYSTEM_PROMPT });
    const l1 = calls.filter(isL1);
    assert.ok(l1.length >= 2, `expected L1 mints, got ${l1.length}`);
    for (const request of l1) {
      assert.strictEqual(request.system, ZZ_SYSTEM_PROMPT);
    }
  });

  it('merge mint requests carry the set prompt as the request system field', async () => {
    const calls = await runWorkload({
      systemPrompt: ZZ_SYSTEM_PROMPT,
      turns: 60,
      strategyOptions: { mergeThreshold: 2 },
    });
    const merges = calls.filter(isMerge);
    assert.ok(merges.length >= 2, `expected >=2 merges, got ${merges.length}`);
    for (const request of merges) {
      assert.strictEqual(request.system, ZZ_SYSTEM_PROMPT);
    }
  });

  it('the prompt leads the request rather than being injected into the head', async () => {
    const calls = await runWorkload({
      systemPrompt: ZZ_SYSTEM_PROMPT,
      turns: 60,
      strategyOptions: { mergeThreshold: 2 },
    });
    assert.ok(calls.length > 0, 'expected mint calls');
    for (const request of calls) {
      // The system field precedes every message on the wire, which is the
      // live activation's own layout (system prompt -> head -> middle).
      assert.strictEqual(request.system, ZZ_SYSTEM_PROMPT);
      const inMessages = request.messages.some((m) =>
        m.content.some((b) => b.type === 'text' && b.text.includes('zz-archivist')));
      assert.ok(!inMessages, 'the prompt must not also be spliced into the replayed messages');
    }
  });

  it('unset: every mint request carries no system key at all', async () => {
    const calls = await runWorkload({ turns: 60, strategyOptions: { mergeThreshold: 2 } });
    assert.ok(calls.some(isL1), 'expected L1 mints in the unset run');
    assert.ok(calls.some(isMerge), 'expected merges in the unset run');
    for (const request of calls) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(request, 'system'),
        'an undeclared prompt must leave the pre-threading request shape untouched',
      );
    }
  });

  it('an empty or undefined later call never downgrades a recorded prompt', async () => {
    // Mirrors setToolDefinitions: the host pushes on every activation, and a
    // momentarily-empty push must not blank what the last real one recorded.
    const calls = await runWorkload({
      systemPrompt: ZZ_SYSTEM_PROMPT,
      laterSystemPrompts: ['', undefined],
    });
    assert.ok(calls.length > 0, 'expected mint calls');
    for (const request of calls) {
      assert.strictEqual(request.system, ZZ_SYSTEM_PROMPT);
    }
  });

  it('KnowledgeStrategy inherits the threading', async () => {
    const calls = await runWorkload({
      knowledge: true,
      systemPrompt: ZZ_SYSTEM_PROMPT,
      drainAtEnd: true,
    });
    assert.ok(calls.length > 0, 'expected KnowledgeStrategy mint calls');
    for (const request of calls) {
      assert.strictEqual(request.system, ZZ_SYSTEM_PROMPT);
    }
  });
});
