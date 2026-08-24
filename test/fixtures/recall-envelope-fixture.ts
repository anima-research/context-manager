/**
 * Shared fixture for the recall-envelope tests (test/recall-envelope.test.ts)
 * and for the golden capture that pins default-mode output byte-for-byte.
 *
 * Two renders, one per emission path that produces recall Q/A pairs:
 *
 *  - `renderHierarchicalFixture` — `selectHierarchical`, the default path.
 *    Summaries are seeded directly (no LLM) so the covered set is exact:
 *    one unmerged L1, two L1s merged into an L2 (the merged-level recall),
 *    and one L1 carrying `responseContent` reasoning carriers, which is the
 *    shape whose signed blocks must survive enveloping untouched.
 *  - `renderAdaptiveFixture` — `selectAdaptive`, reached with
 *    `adaptiveResolution: true`, whose pairs all carry the uniform
 *    `summaryContextLabel` question. Driven end-to-end through a mocked
 *    membrane so the chunk/summary plumbing is real.
 *
 * Both return a plain participant/content projection: that projection is
 * what the golden file holds and what the byte-identity assertion compares,
 * so it must stay free of clocks, paths and store ids.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';
import type { AutobiographicalOptions, SummaryEntry } from '../../src/types/index.js';

export interface RenderedMessage {
  participant: string;
  content: ContentBlock[];
}

/** The attribute-bearing facts of one summary the render could have emitted. */
export interface FixtureSummary {
  id: string;
  level: number;
  first: string;
  last: string;
}

export interface FixtureRender {
  /** What the golden pins: participant + content, no clocks or store ids. */
  messages: RenderedMessage[];
  /** Every summary the strategy held at compile time, for attribute checks. */
  summaries: FixtureSummary[];
  /**
   * Messages of each compression/merge request the strategy issued — the
   * mint-path recall ladder, which is what zero-recall surgery operates on.
   * Empty for fixtures that seed summaries instead of minting them.
   */
  compressionRequests: RenderedMessage[][];
}

/** Strategy subclass that can seed summaries without an LLM round trip. */
class SeedableStrategy extends AutobiographicalStrategy {
  seedSummary(entry: Omit<SummaryEntry, 'id' | 'created'> & { id?: string }): SummaryEntry {
    const seeded: SummaryEntry = {
      ...entry,
      id: entry.id ?? `L${entry.level}-${this.nextSummaryIdCounter()}`,
      created: 0,
    };
    this.pushSummary(seeded);
    return seeded;
  }
}

/** Read the strategy's own summary list; `summaries` is protected. */
function summariesOf(strategy: AutobiographicalStrategy): FixtureSummary[] {
  const held = (strategy as unknown as { summaries: SummaryEntry[] }).summaries;
  return held.map((s) => ({
    id: s.id,
    level: s.level,
    first: s.sourceRange.first,
    last: s.sourceRange.last,
  }));
}

function textContent(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

function project(messages: ReadonlyArray<{ participant: string; content: ContentBlock[] }>): RenderedMessage[] {
  return messages.map((m) => ({ participant: m.participant, content: m.content }));
}

async function withTempStore<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zz-recall-envelope-'));
  try {
    return await run(join(dir, 'zz-store'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Ids of the summaries the hierarchical fixture seeds, in the order their
 * recall pairs are expected to render. Tests assert attribute values against
 * these, so the fixture pins the ids rather than letting the counter pick.
 */
export const HIERARCHICAL_FIXTURE_SUMMARY_IDS = ['L2-100', 'L1-101', 'L1-102'] as const;

/**
 * Render the default (`selectHierarchical`) path over a fixed set of seeded
 * summaries: an L2 merged from two L1s, then two unmerged L1s, the second of
 * which replays reasoning carriers.
 */
export async function renderHierarchicalFixture(
  options: AutobiographicalOptions = {},
): Promise<FixtureRender> {
  return withTempStore(async (path) => {
    const strategy = new SeedableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 8,
      ...options,
    });
    const manager = await ContextManager.open({ path, strategy });

    const zz1 = manager.addMessage('user', textContent('zz-turn-one'));
    const zz2 = manager.addMessage('user', textContent('zz-turn-two'));
    const zz3 = manager.addMessage('user', textContent('zz-turn-three'));
    const zz4 = manager.addMessage('user', textContent('zz-turn-four'));
    manager.addMessage('user', textContent('zz-turn-latest ' + 'Z'.repeat(60)));

    // Two L1s merged away under the L2: anti-redundancy hides a merged L1,
    // so only the L2 renders for the zz-turn-one..zz-turn-two span.
    strategy.seedSummary({
      id: 'L1-0',
      level: 1,
      content: 'zz-memory-merged-one',
      tokens: 6,
      sourceLevel: 0,
      sourceIds: [zz1],
      sourceRange: { first: zz1, last: zz1 },
      mergedInto: 'L2-100',
      parentId: 'L2-100',
    });
    strategy.seedSummary({
      id: 'L1-1',
      level: 1,
      content: 'zz-memory-merged-two',
      tokens: 6,
      sourceLevel: 0,
      sourceIds: [zz2],
      sourceRange: { first: zz2, last: zz2 },
      mergedInto: 'L2-100',
      parentId: 'L2-100',
    });
    strategy.seedSummary({
      id: 'L2-100',
      level: 2,
      content: 'zz-memory-merged-level covering the first two turns',
      tokens: 13,
      sourceLevel: 1,
      sourceIds: ['L1-0', 'L1-1'],
      sourceRange: { first: zz1, last: zz2 },
    });
    strategy.seedSummary({
      id: 'L1-101',
      level: 1,
      content: 'zz-memory-plain-prose',
      tokens: 6,
      sourceLevel: 0,
      sourceIds: [zz3],
      sourceRange: { first: zz3, last: zz3 },
    });
    strategy.seedSummary({
      id: 'L1-102',
      level: 1,
      content: 'zz-memory-with-carriers',
      tokens: 6,
      sourceLevel: 0,
      sourceIds: [zz4],
      sourceRange: { first: zz4, last: zz4 },
      responseContent: [
        { type: 'thinking', thinking: 'zz-carrier-reasoning', signature: 'zz-signature' } as ContentBlock,
        { type: 'text', text: 'zz-memory-with-carriers' },
      ],
    });

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const summaries = summariesOf(strategy);
    manager.close();
    return { messages: project(compiled.messages), summaries, compressionRequests: [] };
  });
}

/**
 * Deterministic membrane stand-in: numbered summaries, no network. Records
 * each request's messages so tests can inspect the mint-path recall ladder.
 */
function makeMockMembrane(): { membrane: unknown; requests: RenderedMessage[][] } {
  const requests: RenderedMessage[][] = [];
  let callCount = 0;
  return {
    requests,
    membrane: {
      complete: async (request: { messages: RenderedMessage[] }) => {
        requests.push(project(request.messages));
        callCount++;
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: `zz-adaptive-memory-${callCount} recollection of an earlier stretch` }],
        };
      },
    },
  };
}

/**
 * Render the adaptive (`selectAdaptive`) path, whose recall questions all
 * carry the uniform `summaryContextLabel` rather than a per-id header.
 */
export async function renderAdaptiveFixture(
  options: AutobiographicalOptions = {},
): Promise<FixtureRender> {
  return withTempStore(async (path) => {
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'zz-mock-model',
      targetChunkTokens: 100,
      recentWindowTokens: 200,
      headWindowTokens: 0,
      mergeThreshold: 3,
      compressionSlackRatio: 0.1,
      adaptiveResolution: true,
      ...options,
    });
    const mock = makeMockMembrane();
    const manager = await ContextManager.open({
      path,
      strategy,
      membrane: mock.membrane as never,
    });
    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', textContent(`zz-adaptive-turn-${i}. ` + 'zzzz '.repeat(40)));
    }
    // Drain compression to a fixed point: eight ticks take this workload
    // past L1 into merged L2s, so the adaptive render carries both levels.
    for (let tick = 0; tick < 8; tick++) await manager.tick();
    const compiled = await manager.compile({ maxTokens: 900, reserveForResponse: 0 });
    const summaries = summariesOf(strategy);
    manager.close();
    return { messages: project(compiled.messages), summaries, compressionRequests: mock.requests };
  });
}
