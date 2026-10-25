/**
 * The greedy solvers (flat-profile, oldest-first) raise the oldest chunk that
 * can rise, passing over one with no summary above it. An operator-held early
 * L1 never merges, so its chunks have no summary above them, and a solver that
 * tried only the oldest chunk stopped every raise behind it: a compile the
 * younger chunks' summaries fit was refused.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';
import { FlatProfileStrategy } from '../src/adaptive/strategies/flat-profile.js';
import type { FoldingBudget } from '../src/adaptive/folding-strategy.js';

const STORE = './test-greedy-held-oldest';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
after(cleanup);

let calls = 0;
const membrane = {
  complete: async () => {
    calls++;
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `summary ${calls}: ` + Array.from({ length: 6 + (calls % 9) }, (_, i) => `w${calls}x${i}`).join(' ') }] };
  },
};

class Lane extends AutobiographicalStrategy {
  get all(): readonly SummaryEntry[] { return this.summaries; }
}

async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try { return await body(); } finally { console.warn = warn; console.error = error; }
}

describe('a greedy solver passes over chunks with no summary above them', () => {
  for (const solver of ['flat-profile', 'oldest-first'] as const) {
    it(`${solver}: a store holding an early L1 out of merges compiles within a budget its younger summaries fit`, async () => {
      cleanup();
      calls = 0;
      const strategy = new Lane({
        adaptiveResolution: true, foldingStrategy: solver, mergeHoldSummaryIds: ['L1-1'], mergeThreshold: 3,
        headWindowTokens: 0, recentWindowTokens: 200, targetChunkTokens: 60, l1HoldbackChunks: 0,
        autoTickOnNewMessage: false, compressionModel: 'mock',
      } as never);
      const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
      try {
        await quietly(async () => {
          for (let n = 0; n < 150; n++) {
            manager.addMessage(n % 2 ? 'Claude' : 'User', [{ type: 'text', text: `m-${n} hello world, and a few more words to give it weight` }]);
            if (n % 5 === 4) for (let t = 0; t < 6; t++) await manager.tick();
          }
        });
        const held = strategy.all.find((s) => s.id === 'L1-1');
        assert.ok(held && !held.mergedInto, 'premise: the held L1 has no parent');
        assert.ok(strategy.all.some((s) => s.level >= 3), 'premise: the younger history has summaries above L2');
        const result = await quietly(() => manager.compile({ maxTokens: 1200, reserveForResponse: 0 }));
        assert.ok(result.renderStats, 'premise: the compile reports what it rendered');
        assert.ok(result.renderStats.total.tokens <= 1200, `the compile fits: ${result.renderStats.total.tokens} tokens`);
      } finally {
        manager.close();
      }
    });
  }
});

// The solve order returns the plan a greedy solver's earlier rule gives
// wherever the compile accepts it, so the strategy hands the solver the line
// its plan check refuses above.
describe('the strategy gives the solver the line its compile refuses above', () => {
  it('a greedy solver is given the hard budget and, as rejectionBudget, that budget with its grace', async () => {
    cleanup();
    calls = 0;
    const strategy = new Lane({
      adaptiveResolution: true, foldingStrategy: 'flat-profile', overBudgetGraceRatio: 0.05, mergeThreshold: 3,
      headWindowTokens: 0, recentWindowTokens: 200, targetChunkTokens: 60, l1HoldbackChunks: 0,
      autoTickOnNewMessage: false, compressionModel: 'mock',
    } as never);
    const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
    const seen: FoldingBudget[] = [];
    const solve = FlatProfileStrategy.prototype.solve;
    FlatProfileStrategy.prototype.solve = function (this: FlatProfileStrategy, ...args: Parameters<typeof solve>) {
      seen.push(args[1]);
      return solve.apply(this, args);
    };
    try {
      await quietly(async () => {
        for (let n = 0; n < 60; n++) {
          manager.addMessage(n % 2 ? 'Claude' : 'User', [{ type: 'text', text: `m-${n} hello world, and a few more words to give it weight` }]);
          if (n % 5 === 4) for (let t = 0; t < 6; t++) await manager.tick();
        }
      });
      seen.length = 0;
      await quietly(() => manager.compile({ maxTokens: 1000, reserveForResponse: 0 }));
      assert.ok(seen.length > 0, 'premise: the compile ran the solver');
      for (const budget of seen) {
        assert.equal(budget.totalBudget, 1000);
        assert.equal((budget as { rejectionBudget?: number }).rejectionBudget, 1050);
      }
    } finally {
      FlatProfileStrategy.prototype.solve = solve;
      manager.close();
    }
  });

  it('the shadow pick at productionBudgetTokens is given that budget and, as rejectionBudget, that budget with its grace', async () => {
    cleanup();
    calls = 0;
    const strategy = new Lane({
      adaptiveResolution: true, foldingStrategy: 'flat-profile', overBudgetGraceRatio: 0.05, productionBudgetTokens: 600,
      mergeThreshold: 3, headWindowTokens: 0, recentWindowTokens: 200, targetChunkTokens: 60, l1HoldbackChunks: 0,
      autoTickOnNewMessage: false, compressionModel: 'mock',
    } as never);
    const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
    const seen: FoldingBudget[] = [];
    const solve = FlatProfileStrategy.prototype.solve;
    FlatProfileStrategy.prototype.solve = function (this: FlatProfileStrategy, ...args: Parameters<typeof solve>) {
      seen.push(args[1]);
      return solve.apply(this, args);
    };
    try {
      await quietly(async () => {
        for (let n = 0; n < 60; n++) {
          manager.addMessage(n % 2 ? 'Claude' : 'User', [{ type: 'text', text: `m-${n} hello world, and a few more words to give it weight` }]);
          if (n % 5 === 4) for (let t = 0; t < 6; t++) await manager.tick();
        }
      });
      seen.length = 0;
      await quietly(() => manager.compile({ maxTokens: 1000, reserveForResponse: 0 }));
      const shadow = seen.filter((budget) => budget.totalBudget === 600);
      assert.ok(shadow.length > 0, 'premise: the compile ran the shadow pick');
      for (const budget of shadow) assert.equal((budget as { rejectionBudget?: number }).rejectionBudget, 630);
    } finally {
      FlatProfileStrategy.prototype.solve = solve;
      manager.close();
    }
  });
});
