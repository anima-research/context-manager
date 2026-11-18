/** Public tick must fence the receipt helper as well as the summary writers. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager, getMintRequestPreimageBytes } from '../src/index.js';

const index = 'mint-preimage-envelopes';
const media = Buffer.from('synthetic inline image').toString('base64');
const answer = { content: [{ type: 'text', text: 'A concise memory of the substantive events.' }],
  stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 12 } };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sites = [
  { name: 'text blob', method: 'storeBlob', occurrence: 1, image: false },
  { name: 'media blob', method: 'storeBlob', occurrence: 1, image: true },
  { name: 'envelope blob', method: 'storeBlob', occurrence: 2, image: true },
  { name: 'envelope registration', method: 'registerState', occurrence: 1, image: true },
  { name: 'envelope index', method: 'treeSet', occurrence: 1, image: true },
] as const;

for (const site of sites) {
  it(`public tick: ${site.name} writer lookup cannot write A's preimage into B`, async () => {
    const path = mkdtempSync(join(tmpdir(), 'c15c-'));
    const store = JsStore.openOrCreate({ path });
    const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0,
      persistMintPreimages: true, compressionModel: 'offline', targetChunkTokens: 200,
      headWindowTokens: 0, recentWindowTokens: 0, minChunkCharsForLLM: 0, l1HoldbackChunks: 0, mergeThreshold: 99 });
    let armed = false, lookups = 0, leakedWrites = 0;
    let requestBytes: Buffer | undefined, replacement: Promise<void> | undefined;
    const manager = await ContextManager.open({ store, strategy, membrane: { complete: async (request: unknown) => {
      requestBytes = Buffer.from(JSON.stringify(request));
      if (site.image) assert.ok(requestBytes.includes(media), 'the real authoring request carries inline media');
      armed = true;
      return answer;
    } } as never });
    const original = store[site.method];
    try {
      const branchA = store.currentBranch().name;
      await manager.fork('B');
      await manager.switchBranch(branchA);
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [
        { type: 'text', text: `MSG-${i} ${'substantive event '.repeat(60)}` },
        ...(site.image ? [{ type: 'image' as const, source: { type: 'base64' as const, mediaType: 'image/png', data: media } }] : []),
      ]);
      await manager.compile({ maxTokens: 100000, reserveForResponse: 100 });
      Object.defineProperty(store, site.method, { configurable: true, get() {
        if (armed && ++lookups === site.occurrence) {
          armed = false;
          replacement = manager.switchBranch('B');
          void replacement.catch(() => {});
          assert.equal(store.currentBranch().name, 'B', 'the lookup really switches the backing branch');
          return function (this: JsStore, ...args: unknown[]) {
            leakedWrites++;
            return Reflect.apply(original, this, args);
          };
        }
        return original;
      } });
      // Some stale tick paths return, others reject: neither may dispatch the writer.
      await manager.tick().catch(() => {});
      assert.ok(requestBytes, 'public tick reached the real provider');
      assert.ok(replacement, 'the selected helper writer lookup reentered the manager');
      await replacement;
      assert.equal(store.currentBranch().name, 'B', 'replacement initialization completed');
      assert.equal(store.treeGet(index, sha256(requestBytes)), null, 'B must not index A\'s receipt');
      assert.equal(leakedWrites, 0, 'the obsolete writer must not even be dispatched (including global blobs/registration)');
      assert.equal(getMintRequestPreimageBytes(store, sha256(requestBytes)), null);
      assert.deepEqual(store.getStateJson('default/autobio:summaries') ?? [], [], 'B must not gain A\'s summary');
    } finally {
      armed = false;
      Reflect.deleteProperty(store, site.method);
      await replacement?.catch(() => {});
      manager.close(); store.close(); rmSync(path, { recursive: true, force: true });
    }
  });
}
