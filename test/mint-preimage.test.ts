/**
 * Readable provenance: mint request preimages (2026-08-24).
 *
 * A minted summary carries `provenance.requestHash`, and the field's comment
 * used to key "the exact request in the llm-calls log" — a log this library
 * never wrote. Hosts that never set `CONTEXT_MANAGER_COMPRESSION_LOG` had
 * provenance they could verify (re-hash a request you already have) but not
 * read (recover the request from the hash). The invariant under test:
 *
 *   For every mint, the exact request preimage is durably retrievable by the
 *   record's own requestHash, and sha256(retrieved) === requestHash. It rides
 *   Chronicle's content-addressed blob store — the same store the summary
 *   persists to, keyed by the same digest — so it survives a reopen. Default
 *   ON; `persistMintPreimages: false` writes nothing and throws nothing.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';

import {
  ContextManager,
  AutobiographicalStrategy,
  getMintRequestByHash,
  getMintRequestPreimageBytes,
} from '../src/index.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

const BASE = './test-mint-preimage';
const ZZ_MINT_MODEL = 'zz-mint-preimage-model';
let sequence = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${BASE}-${sequence++}`;
  paths.push(path);
  return path;
}

function cleanup(): void {
  for (const path of paths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

const t = (text: string): ContentBlock => ({ type: 'text', text });

/** Membrane stand-in that accepts every mint and keeps what it was sent. */
function acceptingMembrane() {
  const calls: unknown[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: unknown) => {
        calls.push(structuredClone(request));
        return {
          stopReason: 'end_turn',
          content: [t(`zz-consolidation-${calls.length}`)],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    } as never,
  };
}

class Probe extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }

  run(chunk: Chunk, context: StrategyContext): Promise<void> {
    return this.compressChunkHierarchical(chunk, context);
  }

  qMerge(level: number, sourceIds: string[]): void {
    this.enqueueMerge({ level, sourceIds });
  }

  summariesView(): SummaryEntry[] {
    return [...this.summaries];
  }
}

function ctx(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Real store + real messages + two seeded L1s with a level-2 merge queued —
 * `tick()` drives the real executeMerge. Mirrors merge-disposition.test.ts.
 */
async function mergeFixture(
  membrane: unknown,
  options: ConstructorParameters<typeof Probe>[0] = {},
  path = freshPath(),
  seedAndQueue = true,
): Promise<{ manager: ContextManager; strategy: Probe }> {
  const strategy = new Probe({
    compressionModel: ZZ_MINT_MODEL,
    hierarchical: true,
    targetChunkTokens: 100_000,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    mergeThreshold: 99,
    quarantineAlarmIntervalMs: 0,
    ...options,
  });
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`zz-raw-${i} ` + 'substance '.repeat(10))]));
  }
  if (seedAndQueue) {
    const l1 = (id: string, a: number, b: number): SummaryEntry => ({
      id,
      level: 1,
      content: `zz-authored ${id}`,
      tokens: 20,
      sourceLevel: 0,
      sourceIds: [ids[a]!, ids[b]!],
      sourceRange: { first: ids[a]!, last: ids[b]! },
      created: 1,
    });
    strategy.seed(l1('L1-900', 0, 1));
    strategy.seed(l1('L1-901', 2, 3));
    strategy.qMerge(2, ['L1-900', 'L1-901']);
  }
  return { manager, strategy };
}

/** Real store whose first chunk closes and compresses through the L1 path. */
async function l1Fixture(
  membrane: unknown,
  options: ConstructorParameters<typeof Probe>[0] = {},
): Promise<{ manager: ContextManager; strategy: Probe }> {
  const strategy = new Probe({
    compressionModel: ZZ_MINT_MODEL,
    targetChunkTokens: 50,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    ...options,
  });
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  for (let i = 0; i < 8; i++) {
    manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`zz-chunked-${i} ` + 'word '.repeat(30))]);
  }
  await manager.compile();
  await strategy.tick(ctx(manager));
  return { manager, strategy };
}

describe('Mint request preimages', () => {
  after(cleanup);

  it('merge mint: the preimage is retrievable by requestHash and hashes back to it', async () => {
    const mock = acceptingMembrane();
    const fx = await mergeFixture(mock.membrane);

    await fx.strategy.tick(ctx(fx.manager));
    const parent = fx.strategy.summariesView().find((s) => s.level === 2);
    assert.ok(parent, 'setup: the merge minted an L2');
    const requestHash = parent!.provenance!.requestHash;
    assert.match(requestHash, /^[a-f0-9]{64}$/);

    const bytes = getMintRequestPreimageBytes(fx.manager.getStore(), requestHash);
    assert.ok(bytes, 'preimage stored under the record\'s own requestHash');
    assert.equal(sha256(bytes!), requestHash, 'sha256(retrieved) === requestHash');

    // The stored bytes are the request the membrane was actually handed —
    // provenance you can read, not a reconstruction.
    assert.deepEqual(
      JSON.parse(bytes!.toString('utf8')),
      JSON.parse(JSON.stringify(mock.calls[0])),
    );

    const parsed = getMintRequestByHash(fx.manager.getStore(), requestHash);
    assert.ok(Array.isArray((parsed as { messages?: unknown[] }).messages));

    // Durable: the preimage outlives the process that minted it.
    await fx.manager.close();
    const reopened = await mergeFixture(mock.membrane, {}, paths[paths.length - 1]!, false);
    const reloaded = getMintRequestPreimageBytes(reopened.manager.getStore(), requestHash);
    assert.ok(reloaded, 'preimage survives close/reopen');
    assert.equal(sha256(reloaded!), requestHash);
    await reopened.manager.close();
  });

  it('L1 mint: the accepted attempt is the preimage stored', async () => {
    const mock = acceptingMembrane();
    const fx = await l1Fixture(mock.membrane);

    const l1 = fx.strategy.summariesView().find((s) => s.level === 1 && s.provenance);
    assert.ok(l1, 'setup: a chunk compressed into an L1 with provenance');
    const requestHash = l1!.provenance!.requestHash;

    const bytes = getMintRequestPreimageBytes(fx.manager.getStore(), requestHash);
    assert.ok(bytes, 'preimage stored for the L1 mint');
    assert.equal(sha256(bytes!), requestHash, 'sha256(retrieved) === requestHash');
    assert.deepEqual(
      JSON.parse(bytes!.toString('utf8')),
      JSON.parse(JSON.stringify(mock.calls[0])),
      'the preimage is the accepted attempt, not a rebuilt request',
    );
    await fx.manager.close();
  });

  it('persistMintPreimages: false writes nothing and mints anyway', async () => {
    const mock = acceptingMembrane();
    const fx = await mergeFixture(mock.membrane, { persistMintPreimages: false });

    await fx.strategy.tick(ctx(fx.manager));
    const parent = fx.strategy.summariesView().find((s) => s.level === 2);
    assert.ok(parent, 'the mint still lands with persistence off');
    const requestHash = parent!.provenance!.requestHash;
    assert.match(requestHash, /^[a-f0-9]{64}$/, 'provenance is unchanged by the off-switch');
    assert.equal(
      getMintRequestPreimageBytes(fx.manager.getStore(), requestHash),
      null,
      'nothing written',
    );
    assert.equal(getMintRequestByHash(fx.manager.getStore(), requestHash), null);
    await fx.manager.close();
  });

  it('provenance keeps exactly its three fields', async () => {
    const mock = acceptingMembrane();
    const fx = await mergeFixture(mock.membrane);

    await fx.strategy.tick(ctx(fx.manager));
    const parent = fx.strategy.summariesView().find((s) => s.level === 2);
    assert.deepEqual(
      Object.keys(parent!.provenance!).sort(),
      ['model', 'requestHash', 'stopReason'],
    );
    assert.equal(parent!.provenance!.stopReason, 'end_turn');
    assert.equal(parent!.provenance!.model, ZZ_MINT_MODEL);
    await fx.manager.close();
  });
});

/**
 * The ACCEPTED request is the authoring request (sol review, 2026-08-24).
 *
 * A mint ladder can send several byte-distinct requests before one is taken:
 * a tool_use rejection re-asks with the no-tools line, and a carrier-400
 * re-asks with reasoning blocks stripped. Only the request the transport
 * ACCEPTED authored the summary, so provenance must hash it, the preimage
 * must BE it, and the rejected bytes must not be stored as anybody's mint
 * preimage. Before this fix the carrier path hashed and persisted the
 * REJECTED original: `sha256(preimage) === requestHash` verified green over
 * bytes the model never read.
 */
type ScriptedAttemptOutcome = 'accept' | 'tool_use' | 'carrier_reject';

interface RecordedAttempt {
  request: NormalizedRequest;
  outcome: ScriptedAttemptOutcome;
}

/** Membrane stand-in that plays a fixed outcome script and keeps every request. */
function scriptedMintMembrane(script: ScriptedAttemptOutcome[]) {
  const attempts: RecordedAttempt[] = [];
  return {
    attempts,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        const outcome = script[attempts.length] ?? 'accept';
        attempts.push({ request: structuredClone(request), outcome });
        if (outcome === 'carrier_reject') {
          throw Object.assign(
            new Error('invalid_request: thinking blocks cannot be modified'),
            { httpStatus: 400 },
          );
        }
        return {
          stopReason: outcome === 'tool_use' ? 'tool_use' : 'end_turn',
          content: [t(`zz-l1-memory-${attempts.length}`)],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    } as never,
  };
}

/**
 * A recall-bearing L1 whose stored response blocks include signed thinking,
 * so the compression request built over it carries reasoning carriers — the
 * precondition for the carrier-transport degraded path.
 */
function zzCarrierL1(id: string, ids: string[], first: number, last: number): SummaryEntry {
  return {
    id,
    level: 1,
    content: `zz-authored ${id}`,
    tokens: 20,
    sourceLevel: 0,
    sourceIds: [ids[first]!, ids[last]!],
    sourceRange: { first: ids[first]!, last: ids[last]! },
    created: 1,
    responseContent: [
      { type: 'thinking', thinking: `zz-private-${id}`, signature: `zz-sig-${id}` },
      { type: 'redacted_thinking', data: `zz-enc-${id}` },
      { type: 'text', text: `zz-authored ${id}` },
    ] as ContentBlock[],
  };
}

/** One chunk, driven straight through the real L1 ladder, over carrier recall. */
async function acceptedRequestFixture(
  membrane: unknown,
): Promise<{ manager: ContextManager; strategy: Probe; target: Chunk }> {
  const strategy = new Probe({
    compressionModel: ZZ_MINT_MODEL,
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    quarantineAlarmIntervalMs: 0,
  });
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`zz-raw-${i} ` + 'substance '.repeat(12))]));
  }
  strategy.seed(zzCarrierL1('L1-900', ids, 0, 1));
  strategy.seed(zzCarrierL1('L1-901', ids, 2, 3));

  const targetIds = new Set(ids.slice(8, 10));
  const target: Chunk = {
    index: 999,
    startIndex: 8,
    endIndex: 10,
    messages: ctx(manager).messageStore.getAll().filter((message) => targetIds.has(message.id)),
    tokens: 100,
    compressed: false,
  };
  return { manager, strategy, target };
}

const acceptedRequestCases: Array<{ label: string; script: ScriptedAttemptOutcome[] }> = [
  { label: 'tool_use rejection then the no-tools retry', script: ['tool_use', 'accept'] },
  { label: 'carrier-400 rejection then the stripped retry', script: ['carrier_reject', 'accept'] },
];

describe('Mint preimages follow the accepted request', () => {
  after(cleanup);

  for (const testCase of acceptedRequestCases) {
    it(`${testCase.label}: provenance and preimage are the accepted bytes`, async () => {
      const mock = scriptedMintMembrane(testCase.script);
      const fx = await acceptedRequestFixture(mock.membrane);

      await fx.strategy.run(fx.target, ctx(fx.manager));

      assert.equal(mock.attempts.length, testCase.script.length, 'setup: the script ran as written');
      const accepted = mock.attempts[mock.attempts.length - 1]!;
      assert.equal(accepted.outcome, 'accept', 'setup: the last attempt is the accepted one');
      const rejected = mock.attempts.slice(0, -1);
      assert.ok(
        mock.attempts[0]!.request.messages.some((message) =>
          message.content.some((block) => block.type === 'thinking'),
        ),
        'setup: the first attempt carries reasoning blocks (the carrier path needs them)',
      );

      const acceptedBytes = Buffer.from(JSON.stringify(accepted.request), 'utf8');
      for (const attempt of rejected) {
        assert.notEqual(
          JSON.stringify(attempt.request),
          acceptedBytes.toString('utf8'),
          'setup: the retry is byte-distinct from the request it replaced',
        );
      }

      const minted = fx.strategy.summariesView().find((entry) => entry.provenance);
      assert.ok(minted, 'the chunk minted an L1 carrying provenance');
      const requestHash = minted!.provenance!.requestHash;
      assert.equal(
        requestHash,
        sha256(acceptedBytes),
        'provenance.requestHash is sha256 of the request the membrane ACCEPTED',
      );

      const stored = getMintRequestPreimageBytes(fx.manager.getStore(), requestHash);
      assert.ok(stored, 'preimage stored under provenance.requestHash');
      assert.equal(
        stored!.toString('utf8'),
        acceptedBytes.toString('utf8'),
        'the stored preimage IS the accepted request, byte for byte',
      );
      assert.equal(sha256(stored!), requestHash, 'sha256(retrieved) === requestHash');

      for (const attempt of rejected) {
        const rejectedHash = sha256(Buffer.from(JSON.stringify(attempt.request), 'utf8'));
        assert.equal(
          getMintRequestPreimageBytes(fx.manager.getStore(), rejectedHash),
          null,
          'a rejected request is not a mint and is not stored as a preimage',
        );
      }

      await fx.manager.close();
    });
  }
});
