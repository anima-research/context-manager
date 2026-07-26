/**
 * Realistic Lena-migration scenario: a chronicle that starts with a large doc,
 * then has many turns of chat about/with that doc.
 *
 * Verifies the doc gets sharded at ingestion, the chat turns coexist with
 * the doc shards, the picker handles both correctly, and the compiled
 * output structure makes sense throughout.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-doc-plus-chat-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function makeMockMembrane() {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      return {
        content: [{ type: 'text', text: `[mock summary #${callCount}] short content.` }],
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

function compiledTokens(compiled: { messages: Array<{ content: any[] }> }): number {
  let total = 0;
  for (const m of compiled.messages) {
    for (const block of m.content) {
      if (block.type === 'text') total += Math.ceil(block.text.length / 4);
    }
  }
  return total;
}

describe('AutobiographicalStrategy — doc + chat workload (Lena-like)', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('500K-equivalent doc + 50 chat turns: budget honored throughout', async () => {
    const mock = makeMockMembrane();
    // 2026-07-12: scaled from 30000 with the content-class estimator rates
    // (prose 2.9 / dense 2.3 vs the old flat chars/4) — same folding pressure
    // relative to the fixture's content, honest units.
    const BUDGET = 45000;
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 1000, // ~4K chars per shard
      recentWindowTokens: 2000,
      mergeThreshold: 6,
      compressionSlackRatio: 0.1,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    // Synthetic ~500K-equivalent doc. Use 50K chars ≈ 12.5K tokens for test
    // speed; chunker treats ~1K tokens per shard. ~12 shards.
    const sections: string[] = [];
    for (let s = 0; s < 12; s++) {
      sections.push(`# Section ${s}\n\n` + 'paragraph content with some words. '.repeat(40));
    }
    const doc = sections.join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: doc }]);

    // Verify sharding happened at ingestion
    const allMessages = manager.getAllMessages();
    assert.ok(allMessages.length > 1, `expected doc to shard; got ${allMessages.length} messages`);
    const shardCount = allMessages.length;
    const groupId = allMessages[0].bodyGroupId;
    assert.ok(groupId, 'first shard should have bodyGroupId');
    for (const m of allMessages) {
      assert.equal(m.bodyGroupId, groupId, 'all shards share bodyGroupId');
    }

    while (!manager.isReady()) {
      await manager.tick();
    }
    // First compile after doc — verify budget honored
    const compiledAfterDoc = await manager.compile({ maxTokens: BUDGET, reserveForResponse: 1000 });
    assert.ok(
      compiledTokens(compiledAfterDoc) <= BUDGET - 1000,
      `after-doc tokens exceed budget: ${compiledTokens(compiledAfterDoc)}`
    );

    // Now 50 chat turns about the doc
    for (let i = 0; i < 50; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Question ${i} about section ${i % 12}: ` + 'word '.repeat(20) }]);
      manager.addMessage('Claude', [{ type: 'text', text: `Answer ${i}: ` + 'word '.repeat(25) }]);
      while (!manager.isReady()) {
        await manager.tick();
      }
      const compiled = await manager.compile({ maxTokens: BUDGET, reserveForResponse: 1000 });
      const tokens = compiledTokens(compiled);
      assert.ok(
        tokens <= BUDGET - 1000,
        `turn ${i}: ${tokens} tokens exceeds budget ${BUDGET - 1000}`
      );
    }

    // The compiled output should still reflect the doc somewhere
    const finalCompile = await manager.compile({ maxTokens: BUDGET, reserveForResponse: 1000 });
    const finalText = finalCompile.messages
      .flatMap((m) => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    // Either the doc is still raw-rendered, OR a summary referring to it appears
    assert.ok(
      finalText.includes('Section') || finalText.includes('summary'),
      'final compile should reference doc content via either raw or summary'
    );

    manager.close();
  });

  it('agent can lock a critical doc section and it survives folding pressure', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 500,
      recentWindowTokens: 500,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    // Doc with distinct sections — big enough to shard at targetChunkTokens=500
    // (chunker threshold = 2x targetChunkTokens = 1000 tokens; we need ~10 sections
    // × 200 tokens = 2000+ tokens to trigger sharding).
    const sections = Array.from({ length: 10 }, (_, i) =>
      `# Section ${i}\n\nCRITICAL-MARKER-${i} ` + 'distinctive word here. '.repeat(40)
    );
    manager.addMessage('User', [{ type: 'text', text: sections.join('\n\n') }]);
    const shards = manager.getAllMessages();
    assert.ok(shards.length > 1, `doc should shard; got ${shards.length} messages`);

    // Lock shard 3 specifically
    const criticalShard = shards[3];
    strategy.lockChunk(criticalShard.id);

    // Add chat to push pressure
    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', [{ type: 'text', text: `T${i}` }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }
    // Tight compile (scaled 2026-07-12 with the content-class estimator rates;
    // same relative pressure as the old 3500 at flat chars/4)
    const compiled = await manager.compile({ maxTokens: 5000, reserveForResponse: 500 });

    // The locked shard's resolution should remain 0 in strategy.resolutions
    const resolutions = (strategy as any).resolutions as Map<string, number>;
    const lockedRes = resolutions.get(criticalShard.id) ?? 0;
    assert.equal(lockedRes, 0, `locked shard should remain L0, got L${lockedRes}`);

    // The compiled output should contain the locked shard's content verbatim
    // (or at least the CRITICAL-MARKER-3 substring from its raw text).
    const allText = compiled.messages
      .flatMap((m) => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    assert.ok(
      allText.includes('CRITICAL-MARKER-3'),
      'compiled output should contain the locked shard\'s content verbatim'
    );
    manager.close();
  });

  it('doc + many turns: shards in different regions render correctly', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 400,
      recentWindowTokens: 800,
      mergeThreshold: 3,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // Doc → some shards in middle, some in tail
    const doc = Array.from({ length: 15 }, (_, i) =>
      `Section ${i}: ` + 'word '.repeat(60)
    ).join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: doc }]);
    // Trailing chat so the doc isn't all-tail
    for (let i = 0; i < 8; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Followup ${i}` }]);
    }
    while (!manager.isReady()) {
      await manager.tick();
    }
    const compiled = await manager.compile({ maxTokens: 5000, reserveForResponse: 500 });

    // The compile should have produced output containing both doc content
    // (some sections) and chat content (followups). The doc should be a
    // combined entry (or entries) representing its shards.
    const userMessages = compiled.messages.filter((m) => m.participant.toLowerCase() === 'user');
    assert.ok(userMessages.length >= 2, 'should have multiple user messages (doc + chat)');

    // Find a user message containing "Section" (from the doc)
    const docEntry = userMessages.find((m) =>
      m.content
        .filter((b: any) => b.type === 'text')
        .some((b: any) => b.text.includes('Section '))
    );
    assert.ok(docEntry, 'should have a user entry with doc section content');

    // Find a user message containing "Followup" (from chat)
    const chatEntry = userMessages.find((m) =>
      m.content
        .filter((b: any) => b.type === 'text')
        .some((b: any) => b.text.includes('Followup'))
    );
    assert.ok(chatEntry, 'should have a user entry with chat followup content');

    manager.close();
  });
});
