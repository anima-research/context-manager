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
import type { ContentBlock } from '@animalabs/membrane';
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
