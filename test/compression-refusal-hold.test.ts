/**
 * A lane whose chunks are refused one after another with nothing landing in
 * their domain between them holds those chunks instead of quarantining them:
 * the refusals say nothing about each chunk while the domain lands nothing.
 * A landing in the domain ends the hold, and the held chunks are asked again
 * one at a time, oldest first. A held chunk refused again is quarantined.
 * Nothing of the hold outlives the process. While a chunk is held the lane
 * reports that it isn't ready, a tick that sends nothing says so, and the
 * quarantine alarm says no all-clear.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { CompressionQuarantineStatus, StrategyContext } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'refusal-hold-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG = {
  compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
  autoTickOnNewMessage: false, l1HoldbackChunks: 0, minChunkCharsForLLM: 0, mergeThreshold: 99,
  compressionRefusalCurveFallbacks: 0, compressionSourceOnly: true, quarantineAlarmIntervalMs: 3_600_000,
};

type Chunk = { compressed: boolean; messages: Array<{ id: string }> };
type Lane = AutobiographicalStrategy & { chunks: Chunk[] };

/** Which turns a request carries, by the marker each turn's text opens with. */
const turnsIn = (request: NormalizedRequest): number[] =>
  [...JSON.stringify(request.messages).matchAll(/turn-(\d+) /g)].map((m) => Number(m[1]));

class Provider {
  calls: number[][] = [];
  /** Requests that merge summaries: their instruction asks for a consolidation. */
  merges = 0;
  /** Whether it refuses a request carrying these turns. */
  refuses: (turns: number[]) => boolean = () => false;
  readonly membrane = {
    complete: async (request: NormalizedRequest) => {
      const turns = [...new Set(turnsIn(request))];
      this.calls.push(turns);
      if (/consolidat/i.test(JSON.stringify(request))) this.merges += 1;
      return this.refuses(turns)
        ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
          raw: { response: { stop_details: { category: 'cyber' } } } }
        : { content: [{ type: 'text', text: `memory of ${turns.join(',')}` }], stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  /** How many requests asked to compress the chunk of these turns, and no other. */
  asked(chunk: { turns: number[] }): number {
    const key = chunk.turns.join(',');
    return this.calls.filter((turns) => turns.join(',') === key).length;
  }
}

const context = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

async function open(name: string, provider: Provider, config: Record<string, unknown> = {}) {
  const strategy = new AutobiographicalStrategy({ ...CONFIG, ...config } as never) as Lane;
  const manager = await ContextManager.open({ path: join(dir, name), strategy, membrane: provider.membrane as never });
  let next = 0;
  const lane = {
    strategy, manager,
    /** Add `count` turns and let the strategy queue the chunks they close. */
    async say(count: number): Promise<void> {
      for (let i = 0; i < count; i++, next++) {
        manager.addMessage(next % 2 ? 'Claude' : 'User', [{ type: 'text', text: `turn-${next} ${'substantive '.repeat(12)}` }]);
      }
      await strategy.onNewMessage(manager.queryMessages({}).messages.at(-1)!, context(manager));
    },
    /** The closed chunks, each by the turns it holds. */
    chunks(): Array<{ turns: number[]; compressed: boolean }> {
      const at = new Map(manager.queryMessages({}).messages.map((m, i) => [m.id, i]));
      return strategy.chunks.map((c) => ({ turns: c.messages.map((m) => at.get(m.id)!), compressed: c.compressed }));
    },
    /** Tick `times` times; the errors that ticks threw, in order. */
    async tick(times: number): Promise<string[]> {
      const thrown: string[] = [];
      for (let i = 0; i < times; i++) {
        try {
          await strategy.tick(context(manager));
        } catch (error) {
          thrown.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        }
      }
      return thrown;
    },
    quarantined: (): number => strategy.getCompressionQuarantineStatus().count,
    ready: (): boolean => strategy.checkReadiness().ready,
  };
  return lane;
}

describe('a lane whose chunks are refused one after another with nothing landing between them', () => {
  it('holds every chunk of an episode, and once the provider answers a new chunk each held chunk compresses, with no quarantine record left', async () => {
    const provider = new Provider();
    provider.refuses = () => true;
    const lane = await open('episode', provider);
    await lane.say(12);
    const episode = lane.chunks();
    assert.ok(episode.length >= 3, `setup: three chunks or more, got ${episode.length}`);
    await lane.tick(episode.length + 2);
    assert.equal(lane.quarantined(), 0, 'no chunk of the episode stays quarantined');
    for (const chunk of episode) assert.equal(provider.asked(chunk), 1, `chunk of turn ${chunk.turns[0]} asked once`);

    provider.refuses = () => false;
    await lane.say(4);
    await lane.tick(episode.length + 4);
    assert.ok(lane.chunks().every((chunk) => chunk.compressed), 'every chunk compressed');
    assert.equal(lane.quarantined(), 0, 'no quarantine record');
    for (const chunk of episode) {
      assert.equal(provider.asked(chunk), 2,
        `chunk of turn ${chunk.turns[0]} asked twice in all; chunks ${JSON.stringify(lane.chunks())}, requests ${JSON.stringify(provider.calls)}`);
    }
    lane.manager.close();
  });

  it('asks two chunks that are refused for their content a second time, after a landing, and then quarantines them; every other chunk compresses', async () => {
    const provider = new Provider();
    const lane = await open('content', provider);
    await lane.say(20);
    const chunks = lane.chunks();
    assert.ok(chunks.length >= 5, `setup: five chunks or more, got ${chunks.length}`);
    const refused = new Set([...chunks[1]!.turns, ...chunks[2]!.turns]);
    provider.refuses = (turns) => turns.some((n) => refused.has(n));
    await lane.tick(chunks.length * 3);
    assert.equal(provider.asked(chunks[1]!), 2, 'the first refused chunk is asked twice');
    assert.equal(provider.asked(chunks[2]!), 2, 'the second refused chunk is asked twice');
    assert.equal(lane.quarantined(), 2, 'both are quarantined');
    const others = lane.chunks().filter((_, i) => i !== 1 && i !== 2);
    assert.ok(others.every((chunk) => chunk.compressed), 'every other chunk compressed');
    lane.manager.close();
  });

  it('pays one chunk for a landing in the middle of an episode: the oldest held chunk is asked again and quarantined, and the rest stay held', async () => {
    const provider = new Provider();
    const lane = await open('stray-landing', provider);
    await lane.say(16);
    const chunks = lane.chunks();
    assert.ok(chunks.length >= 4, `setup: four chunks or more, got ${chunks.length}`);
    const lands = new Set(chunks[3]!.turns);
    provider.refuses = (turns) => !turns.some((n) => lands.has(n));
    await lane.tick(chunks.length * 3);
    assert.ok(lane.chunks()[3]!.compressed, 'the chunk the provider answered compressed');
    assert.equal(lane.quarantined(), 1, 'one chunk is quarantined');
    assert.equal(provider.asked(chunks[0]!), 2, 'the oldest held chunk was asked again');
    assert.equal(provider.asked(chunks[1]!), 1, 'the next held chunk waits for the next landing');

    provider.refuses = () => false;
    await lane.say(4);
    await lane.tick(chunks.length * 3);
    assert.equal(lane.quarantined(), 1, 'only that one stays quarantined');
    assert.ok(lane.chunks().every((chunk, i) => i === 0 || chunk.compressed), 'every other chunk compressed');
    lane.manager.close();
  });

  it('leaves no quarantine record when the process restarts during a hold, and the restarted lane asks each held chunk again', async () => {
    const provider = new Provider();
    provider.refuses = () => true;
    const first = await open('restart', provider);
    await first.say(12);
    const chunks = first.chunks().length;
    assert.ok(chunks >= 3, `setup: three chunks or more, got ${chunks}`);
    await first.tick(chunks + 2);
    assert.equal(first.quarantined(), 0, 'no record stands at the restart');
    first.manager.close();

    provider.refuses = () => false;
    const second = await open('restart', provider);
    await second.strategy.onNewMessage(second.manager.queryMessages({}).messages.at(-1)!, context(second.manager));
    await second.tick(chunks + 2);
    assert.ok(second.chunks().length >= chunks, 'setup: the chunks are back');
    assert.ok(second.chunks().every((chunk) => chunk.compressed), 'every chunk compressed after the restart');
    assert.equal(second.quarantined(), 0, 'no quarantine record');
    second.manager.close();
  });

  it('reports that the lane isn\'t ready while a chunk is held, and each tick that sends nothing says why, in the house\'s words', async () => {
    const provider = new Provider();
    provider.refuses = () => true;
    const lane = await open('loud', provider);
    await lane.say(12);
    const chunks = lane.chunks().length;
    await lane.tick(chunks);
    const sent = provider.calls.length;
    const thrown = await lane.tick(2);
    assert.equal(provider.calls.length, sent, 'a resting lane sends nothing');
    assert.equal(thrown.length, 2, 'each tick that sends nothing throws');
    assert.equal(thrown[0], thrown[1], 'with the same words each time');
    assert.match(thrown[0]!, /held/);
    assert.doesNotMatch(thrown[0]!, /cyber|refusal_category|stop_details/, 'no provider words');
    assert.equal(lane.ready(), false, 'the lane isn\'t ready');
    lane.manager.close();
  });

  it('quarantines a chunk whose request is rejected for its shape, even during a hold', async () => {
    const provider = new Provider();
    const lane = await open('shape', provider);
    await lane.say(12);
    const chunks = lane.chunks();
    const rejected = new Set(chunks[2]!.turns);
    provider.refuses = () => true;
    const refuse = provider.membrane.complete;
    provider.membrane.complete = async (request: NormalizedRequest) => {
      if (turnsIn(request).some((n) => rejected.has(n))) {
        throw Object.assign(new Error('synthetic rejection'), { type: 'invalid_request' });
      }
      return refuse(request);
    };
    await lane.tick(chunks.length + 1);
    assert.equal(lane.quarantined(), 1, 'the rejected chunk is quarantined, and the refused ones are held');
    assert.equal(lane.ready(), false, 'the lane still holds the refused chunks');
    lane.manager.close();
  });

  it('sends no merge while it holds chunks, and the queued merge goes once a compression lands', async () => {
    const provider = new Provider();
    const lane = await open('merges', provider, { mergeThreshold: 2 });
    await lane.say(8);
    await lane.tick(2);
    assert.ok(lane.chunks().every((chunk) => chunk.compressed), 'setup: two chunks compressed');
    assert.equal(provider.merges, 0, 'setup: their merge is queued, not yet sent');
    provider.refuses = () => true;
    await lane.say(8);
    await lane.tick(6);
    assert.equal(provider.merges, 0, 'no merge is sent while the lane holds chunks');
    assert.equal(lane.quarantined(), 0, 'nothing is quarantined');

    provider.refuses = () => false;
    await lane.say(4);
    await lane.tick(8);
    assert.ok(provider.merges > 0, 'the merge goes once a compression lands');
    lane.manager.close();
  });

  it('says no all-clear while a chunk is held, and says it once every held chunk has compressed', async () => {
    const provider = new Provider();
    provider.refuses = () => true;
    const lane = await open('all-clear', provider);
    await lane.say(12);
    const said: string[] = [];
    const handled: CompressionQuarantineStatus[] = [];
    lane.strategy.setQuarantineAlarmHandler((status) => handled.push(status));
    const alarm = () => (lane.strategy as unknown as { soundQuarantineAlarmIfNeeded(): Promise<void> }).soundQuarantineAlarmIfNeeded();
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    const { error } = console;
    console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
    try {
      await lane.tick(1);
      await alarm();
      assert.deepEqual(handled.map((status) => status.count), [1], 'setup: the alarm sounds on the first refused chunk');
      await lane.tick(lane.chunks().length + 1);
      skew += 3_600_001;
      await alarm();
      assert.ok(!said.some((line) => line.includes('ALL CLEAR')), 'no all-clear while chunks are held');

      provider.refuses = () => false;
      await lane.say(4);
      await lane.tick(lane.chunks().length + 2);
      assert.ok(lane.chunks().every((chunk) => chunk.compressed), 'setup: every chunk compressed');
      skew += 3_600_001;
      await alarm();
      assert.equal(said.filter((line) => line.includes('ALL CLEAR')).length, 1, 'one all-clear once nothing is held');
    } finally {
      console.error = error;
      Date.now = realNow;
      lane.manager.close();
    }
  });
});
