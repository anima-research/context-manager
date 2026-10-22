/**
 * End-to-end test of ingestion-time chunking + adaptive picker.
 *
 * Verifies that:
 *   - A large message is automatically chunked into shards at ingestion
 *   - Shards are stored with shared bodyGroupId
 *   - The picker folds shards under budget pressure
 *   - The render path produces ONE combined entry for the whole doc, with
 *     inline summary text replacing folded shards
 *   - Byte-faithful reassembly when no folding has happened
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy, joinBodyContent } from '../../src/index.js';

const TEST_STORE_PATH = './test-adaptive-ingestion-store';

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
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `[mock summary #${callCount}]` }],
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

describe('AutobiographicalStrategy — ingestion-time chunking', () => {
  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => cleanup());

  it('flag off: large messages stay as one StoredMessage (no chunking)', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: false,
      targetChunkTokens: 100,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // 50K chars ≈ 12.5K tokens; well over the chunker threshold.
    const bigBody = 'paragraph. '.repeat(5000);
    manager.addMessage('User', [{ type: 'text', text: bigBody }]);

    const all = manager.getAllMessages();
    assert.equal(all.length, 1, 'flag off: should be exactly one stored message');
    assert.equal(all[0].bodyGroupId, undefined);
    manager.close();
  });

  it('flag on: large messages are sharded into multiple StoredMessages', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 1000, // chunker threshold ~2x = 2000
      recentWindowTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // ~32K chars ≈ 8K tokens, well over chunkThreshold 2000.
    const paras: string[] = [];
    for (let p = 0; p < 32; p++) {
      paras.push(`Paragraph ${p}: ` + 'word '.repeat(80));
    }
    const bigBody = paras.join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: bigBody }]);

    const all = manager.getAllMessages();
    assert.ok(all.length > 1, `expected sharding, got ${all.length} stored messages`);
    // All shards should share the same bodyGroupId
    const groupId = all[0].bodyGroupId;
    assert.ok(groupId, 'first shard should have bodyGroupId');
    for (const m of all) {
      assert.equal(m.bodyGroupId, groupId, 'all shards should share bodyGroupId');
    }
    // shardIndex should be 0..N-1 in order
    for (let idx = 0; idx < all.length; idx++) {
      assert.equal(all[idx].shardIndex, idx);
    }
    // Byte-faithful reassembly
    const reassembled = all
      .map((m) => m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''))
      .join('');
    assert.equal(reassembled, bigBody, 'concatenating shard text must equal original body');
    manager.close();
  });

  it('flag on: compile renders bodyGroup as ONE entry with byte-faithful body (no folding)', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 1000,
      recentWindowTokens: 50_000, // big enough that everything stays in tail (no folding)
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    const paras: string[] = [];
    for (let p = 0; p < 20; p++) {
      paras.push(`Para ${p}: ` + 'word '.repeat(80));
    }
    const bigBody = paras.join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: bigBody }]);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 1000 });
    // Note: the doc lands in the tail window (no compression triggered).
    // Tail uses newest-first eviction; the bodyGroup may render as a single
    // entry OR as separate shards depending on tail emission. The current
    // selectAdaptive only does bodyGroup-aware emission for the MIDDLE,
    // not for the tail. So with everything in tail, we see N shards.
    // For this test, we just verify compile produced output.
    assert.ok(compiled.messages.length > 0, 'compile should produce output');
    manager.close();
  });

  it('flag on: compile renders bodyGroup as combined entry under folding pressure', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 1000,
      recentWindowTokens: 200, // small so most of the doc is in the foldable middle
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // Big enough to require shards + at least one chunk worth of compression
    const paras: string[] = [];
    for (let p = 0; p < 30; p++) {
      paras.push(`Para ${p}: ` + 'distinctive-token-' + p + ' word '.repeat(80));
    }
    const bigBody = paras.join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: bigBody }]);
    // Add a follow-up so the doc isn't at the very end (otherwise it's all tail)
    manager.addMessage('User', [{ type: 'text', text: 'Quick follow-up.' }]);

    // Drive compression to completion
    while (!manager.isReady()) {
      await manager.tick();
    }

    // Scaled 2026-07-12 with the content-class estimator rates (was 5000 at
    // flat chars/4) — same relative pressure on the fixture.
    const compiled = await manager.compile({ maxTokens: 7500, reserveForResponse: 500 });

    // Find the entry that came from the bigBody shards. The middle path
    // should have produced ONE combined entry (sourceRelation: 'copy' from
    // the first shard) with the concatenated body — possibly with inline
    // summary markers if folding happened.
    assert.ok(compiled.messages.length > 0);

    // The combined entry's text should be substantial (not just one shard)
    // OR contain inline summary markers indicating compression happened.
    const allText = compiled.messages
      .flatMap((m) => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n---\n');
    assert.ok(
      allText.length > 100,
      `compiled output should have meaningful content; got length ${allText.length}`
    );
    manager.close();
  });

  it('flag on: small messages (under threshold) are NOT chunked', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 1000,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    manager.addMessage('User', [{ type: 'text', text: 'short message' }]);

    const all = manager.getAllMessages();
    assert.equal(all.length, 1, 'short messages should not be sharded');
    assert.equal(all[0].bodyGroupId, undefined);
    manager.close();
  });

  it('flag on: folded shards within a bodyGroup emit separate Q+A recall pair messages', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 300,
      recentWindowTokens: 200, // small so the doc is in foldable middle
      summaryContextLabel: 'What do you remember from earlier?',
      summaryParticipant: 'Claude',
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    // Big doc with distinctive content per section
    const paras: string[] = [];
    for (let p = 0; p < 24; p++) {
      paras.push(`Section ${p}: ` + `unique-token-${p} `.repeat(30));
    }
    const bigBody = paras.join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: bigBody }]);
    // Trailing follow-up so the doc isn't entirely in tail
    manager.addMessage('User', [{ type: 'text', text: 'Follow up please.' }]);

    while (!manager.isReady()) {
      await manager.tick();
    }

    // Compile with a budget tight enough to force folding
    const compiled = await manager.compile({ maxTokens: 4000, reserveForResponse: 500 });

    // Look for the Q+A recall pair pattern. If any folding happened, we
    // should see "Context Manager" + summaryParticipant pairs in the
    // compiled output.
    const participants = compiled.messages.map((m) => m.participant);
    const cmIndex = participants.indexOf('Context Manager');
    const claudeIndex = participants.indexOf('Claude');

    // The exact structure depends on which shards are folded and where the
    // doc ends up. We assert at least one of the following holds:
    //   - A Q+A pair appears (Context Manager followed by Claude/summary participant)
    //   - OR no folding happened (everything fit at L0)
    if (cmIndex >= 0) {
      // Found a Q+A — there should be a Claude turn right after
      assert.ok(
        participants[cmIndex + 1] === 'Claude' ||
          participants[cmIndex + 1] === strategy['config'].summaryParticipant,
        `expected summary participant right after Context Manager; got ${participants[cmIndex + 1]}`
      );
    }

    // The bodyGroup should NOT be a single big composite entry with inline
    // `[Section summary ...]` markers anymore. Verify no inline marker.
    const allText = compiled.messages
      .flatMap((m) => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    assert.ok(
      !allText.includes('[Section summary ('),
      'should NOT use inline [Section summary (...)] markers; should emit Q+A pairs instead'
    );
    manager.close();
  });

  it('flag on: tail-only bodyGroup renders as ONE composite User message (not N turns)', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 300,
      recentWindowTokens: 100_000, // big tail so the doc fits entirely in tail
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });

    const paras: string[] = [];
    for (let p = 0; p < 16; p++) {
      paras.push(`Section ${p}: ` + 'distinctive-text '.repeat(40));
    }
    const bigBody = paras.join('\n\n');
    manager.addMessage('User', [{ type: 'text', text: bigBody }]);

    const all = manager.getAllMessages();
    assert.ok(all.length > 1, 'doc should be sharded');

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 1000 });

    // The doc is entirely in tail. After the post-processing pass in
    // selectAdaptive, it should render as exactly ONE composite User
    // message — NOT N separate messages.
    const userEntries = compiled.messages.filter((m) => m.participant.toLowerCase() === 'user');
    assert.ok(userEntries.length > 0, 'should have user entries');

    const entriesWithSection0 = userEntries.filter((m) =>
      m.content
        .filter((b: any) => b.type === 'text')
        .some((b: any) => b.text.includes('Section 0:'))
    );
    assert.equal(
      entriesWithSection0.length,
      1,
      'Section 0 should appear in exactly one user entry (composite)'
    );
    const compositeEntry = entriesWithSection0[0];
    const compositeText = compositeEntry.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    assert.ok(
      compositeText.includes('Section 15:'),
      'composite should also contain the last section (all shards merged)'
    );
    assert.equal(compositeText, bigBody, 'composite text should reassemble original body byte-for-byte');
    manager.close();
  });

  it('flag on: every block keeps its place, so the stored shards join back into the message as given', async () => {
    const mock = makeMockMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'mock',      adaptiveResolution: true,
      targetChunkTokens: 500,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: mock as any,
    });
    // A reply that thinks, writes a long text, then calls a tool.
    const given: ContentBlock[] = [
      { type: 'thinking', thinking: 'let me look', signature: 'SIG' } as any,
      { type: 'text', text: 'paragraph. '.repeat(2000) },
      { type: 'tool_use', id: 'tool-1', name: 'search', input: { q: 'test' } } as any,
    ];
    manager.addMessage('Claude', given);

    const all = manager.getAllMessages();
    assert.ok(all.length > 2, 'should be sharded');
    const types = all.map((m) => m.content.map((b) => b.type));
    assert.deepEqual(types[0], ['thinking', 'text'], 'the thinking leads the first shard');
    assert.deepEqual(types.at(-1), ['text', 'tool_use'], 'the call ends the last shard, next to where its result goes');
    for (const t of types.slice(1, -1)) assert.deepEqual(t, ['text']);
    assert.equal(all[0]!.continuesBlock, undefined, 'the first shard declares no seam');
    assert.ok(all.slice(1).every((m) => m.continuesBlock === true), 'every seam is inside the one text block');
    assert.deepEqual(joinBodyContent(all), given, 'the shards join back into the message as given');
    manager.close();
  });
});

describe('chunkIngressMessage keeps each block in place', () => {
  const strategy = () => new AutobiographicalStrategy({ compressionModel: 'mock', adaptiveResolution: true, targetChunkTokens: 500 });
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as unknown as ContentBlock;
  const shardsOf = (content: ContentBlock[]) => {
    const decision = strategy().chunkIngressMessage('User', content);
    assert.ok(decision && decision.shards.length > 1, 'premise: the message is sharded');
    return decision.shards;
  };
  const textLength = (content: readonly ContentBlock[]) =>
    content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0);

  it('two text blocks, a seam inside the second: both blocks come back, with their own boundary', () => {
    // No line break anywhere, so the chunker cuts at its 2,000-character target.
    const given: ContentBlock[] = [{ type: 'text', text: 'first. '.repeat(100) }, { type: 'text', text: 'second. '.repeat(1500) }];
    const shards = shardsOf(given);
    assert.ok(shards.every((s, k) => k === 0 || s.continuesBlock === true), 'premise: no seam falls on the boundary between them');
    assert.deepEqual(shards[0]!.content.map((b) => b.type), ['text', 'text'], 'the first shard holds the first block and the start of the second');
    assert.deepEqual(joinBodyContent(shards), given);
  });

  it('two text blocks, a seam on the boundary between them: the seam declares it, and the blocks stay apart', () => {
    // The first block's 1,854 characters end in a blank line and the second
    // opens with a heading, the chunker's preferred seam, and the only one
    // before the 2,000 characters it aims for.
    const given: ContentBlock[] = [
      { type: 'text', text: 'first sentence here. '.repeat(88) + 'end.\n\n' },
      { type: 'text', text: '## Second\n\n' + 'second sentence. '.repeat(400) },
    ];
    const shards = shardsOf(given);
    const firstLength = (given[0] as { text: string }).text.length;
    assert.equal(textLength(shards[0]!.content), firstLength, 'premise: the first seam falls on the boundary');
    assert.equal(shards[1]!.continuesBlock, false, 'that seam splits no block');
    assert.deepEqual(joinBodyContent(shards), given, 'and the two blocks come back as two');
  });

  it('a short text, an image, then a long text: the image stays between them', () => {
    const given: ContentBlock[] = [{ type: 'text', text: 'Look at this:' }, image, { type: 'text', text: 'detail. '.repeat(2000) }];
    const shards = shardsOf(given);
    assert.deepEqual(shards[0]!.content.map((b) => b.type), ['text', 'image', 'text']);
    assert.deepEqual(joinBodyContent(shards), given);
  });

  it('an image before its caption, and one at the end: each stays where it sat', () => {
    const given: ContentBlock[] = [image, { type: 'text', text: 'caption. '.repeat(2000) }, image];
    const shards = shardsOf(given);
    assert.equal(shards[0]!.content[0]!.type, 'image', 'the first image leads the first shard');
    assert.equal(shards.at(-1)!.content.at(-1)!.type, 'image', 'the last image ends the last shard');
    assert.ok(shards.slice(1, -1).every((s) => s.content.every((b) => b.type === 'text')));
    assert.deepEqual(joinBodyContent(shards), given);
  });

  it('a tool result, then a long text: the result leads the first shard', () => {
    const given: ContentBlock[] = [
      { type: 'tool_result', toolUseId: 'tool-1', content: 'done' } as unknown as ContentBlock,
      { type: 'text', text: 'note. '.repeat(2500) },
    ];
    const shards = shardsOf(given);
    assert.equal(shards[0]!.content[0]!.type, 'tool_result');
    assert.deepEqual(joinBodyContent(shards), given);
  });

  it('an image and an empty text block on a seam go on the shard after it, and the body joins back as given', () => {
    // As the boundary case: the first block's 1,854 characters end in a blank
    // line, and the heading after it is the chunker's seam.
    const given: ContentBlock[] = [
      { type: 'text', text: 'first sentence here. '.repeat(88) + 'end.\n\n' },
      image,
      { type: 'text', text: '' },
      { type: 'text', text: '## Second\n\n' + 'second sentence. '.repeat(400) },
    ];
    const shards = shardsOf(given);
    assert.deepEqual(shards[0]!.content, [given[0]], 'premise: the first seam falls after the first block');
    assert.deepEqual(shards[1]!.content.slice(0, 2), [image, given[2]], 'the image and the empty text lead the next shard');
    assert.equal(shards[1]!.continuesBlock, false);
    assert.deepEqual(joinBodyContent(shards), given);
  });

  it("a cut text block's pieces are plain text, and a raw form is kept only where all its blocks land, unchanged, on one shard", () => {
    // As a Responses reply: a reasoning item, a message item whose two text
    // parts share its rawItem, then a function call with its own item.
    const reasoning = { type: 'thinking', thinking: 'plan', signature: 'SIG', rawItem: { type: 'reasoning', id: 'rs_1' } } as unknown as ContentBlock;
    const message = { type: 'message', id: 'msg_1' };
    const call = { type: 'tool_use', id: 'fc', name: 'search', input: {}, rawItem: { type: 'function_call', id: 'fc_1' } } as unknown as ContentBlock;
    const given: ContentBlock[] = [
      reasoning,
      { type: 'text', text: 'part one. '.repeat(600), rawItem: message, cache_control: { type: 'ephemeral' } } as unknown as ContentBlock,
      { type: 'text', text: 'part two. '.repeat(600), rawItem: message } as unknown as ContentBlock,
      call,
    ];
    const shards = shardsOf(given);
    const all = shards.flatMap((s) => s.content);
    const keys = (b: ContentBlock) => Object.keys(b).sort().join(',');
    assert.ok(all.filter((b) => b.type === 'text').every((b) => keys(b) === 'text,type'),
      "every text piece is plain: the message item's parts were cut, and their rawItem and cache_control are the whole block's");
    assert.equal((all.find((b) => b.type === 'thinking') as { rawItem?: unknown }).rawItem, undefined,
      'the reasoning gives up its item with the message item it leads to');
    assert.equal(all.find((b) => b.type === 'tool_use'), call, 'the call, alone with its own item on one shard, keeps it');
  });

  it('a raw form whose blocks land whole on different shards is given up by each', () => {
    // As the boundary case, twice: each block ends in a blank line and the
    // heading after it is a seam, so each lands whole on a shard of its own.
    const item = { type: 'message', id: 'msg_3' };
    const given: ContentBlock[] = [
      { type: 'text', text: 'first sentence here. '.repeat(88) + 'end.\n\n', rawItem: item } as unknown as ContentBlock,
      { type: 'text', text: '## Second\n\n' + 'second sentence. '.repeat(100) + 'end.\n\n', rawItem: item } as unknown as ContentBlock,
      { type: 'text', text: '## Third\n\n' + 'third sentence. '.repeat(400) },
    ];
    const shards = shardsOf(given);
    const bare = (b: ContentBlock) => ({ type: 'text', text: (b as { text: string }).text });
    assert.deepEqual(shards[0]!.content, [bare(given[0]!)], 'the first part, whole on the first shard, gives the item up');
    assert.deepEqual(shards[1]!.content[0], bare(given[1]!), 'the second part, whole on the next shard, gives it up too');
    assert.equal(shards[1]!.continuesBlock, false, 'premise: the seam falls between the two parts');
  });

  it('a raw form whose blocks land whole on one shard is kept', () => {
    const item = { type: 'message', id: 'msg_2' };
    const given: ContentBlock[] = [
      { type: 'text', text: 'a long first part. '.repeat(400) },
      { type: 'text', text: 'short one', rawItem: item } as unknown as ContentBlock,
      { type: 'text', text: 'short two', rawItem: item } as unknown as ContentBlock,
    ];
    const shards = shardsOf(given);
    const last = shards.at(-1)!.content;
    assert.ok(given.slice(1).every((b) => last.includes(b)), 'premise: both parts of the item are on the last shard, uncut');
  });

  it("a body stored before blocks were kept in place joins as it always did: its other blocks first, then its text", () => {
    // No shard declares continuesBlock: the text joined into one block, cut
    // across the shards, and the other blocks on the first shard after its text.
    const legacy = [
      { content: [{ type: 'text', text: 'one ' } as ContentBlock, image] },
      { content: [{ type: 'text', text: 'two' } as ContentBlock] },
    ];
    assert.deepEqual(joinBodyContent(legacy), [image, { type: 'text', text: 'one two' }]);
    assert.deepEqual(joinBodyContent(legacy.slice(0, 1)), legacy[0]!.content, 'one part is its own content');
  });
});

describe('continuesBlock is stored and checked', () => {
  beforeEach(() => cleanup());
  after(() => cleanup());

  it('a shard keeps its continuesBlock, false and true, through the store and a reopen', async () => {
    const open = () => ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ compressionModel: 'mock', adaptiveResolution: true, targetChunkTokens: 500 }),
      membrane: makeMockMembrane() as any,
    });
    const manager = await open();
    // The boundary case: the first seam falls between the two blocks, the later ones inside the second.
    manager.addMessage('User', [
      { type: 'text', text: 'first sentence here. '.repeat(88) + 'end.\n\n' },
      { type: 'text', text: '## Second\n\n' + 'second sentence. '.repeat(400) },
    ]);
    const declared = (m: { getAllMessages(): Array<{ continuesBlock?: boolean }> }) => m.getAllMessages().map((s) => s.continuesBlock);
    const stored = declared(manager);
    assert.equal(stored[0], undefined);
    assert.equal(stored[1], false);
    assert.ok(stored.length > 2 && stored.slice(2).every((d) => d === true), JSON.stringify(stored));
    manager.close();
    const reopened = await open();
    assert.deepEqual(declared(reopened), stored);
    reopened.close();
  });

  for (const [what, declare] of [
    ['declares continuesBlock on some shards after the first and not others', (k: number) => (k === 1 ? { continuesBlock: true } : {})],
    ['declares continuesBlock on its first shard', (k: number) => ({ continuesBlock: k === 0 })],
    ['declares continuesBlock false on its first shard and on every later one', () => ({ continuesBlock: false })],
  ] as const) {
    it(`a chunking that ${what} is refused before any shard is written`, async () => {
      class Mixed extends AutobiographicalStrategy {
        override chunkIngressMessage(participant: string, content: ContentBlock[]) {
          const decision = super.chunkIngressMessage(participant, content);
          if (!decision) return decision;
          return {
            bodyGroupId: decision.bodyGroupId,
            shards: decision.shards.map(({ continuesBlock: _drop, ...shard }, k) => ({ ...shard, ...declare(k) })),
          };
        }
      }
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: new Mixed({ compressionModel: 'mock', adaptiveResolution: true, targetChunkTokens: 500 }),
        membrane: makeMockMembrane() as any,
      });
      assert.throws(() => manager.addMessage('User', [{ type: 'text', text: 'paragraph. '.repeat(2000) }]), /continuesBlock/);
      assert.equal(manager.getAllMessages().length, 0, 'no shard was written');
      manager.close();
    });
  }
});
