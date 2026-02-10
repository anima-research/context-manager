import { describe, it, before, after, skip } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, PassthroughStrategy, AutobiographicalStrategy, ContextLog, MessageStore } from '../src/index.js';
import { JsStore } from 'chronicle';
import type { ContentBlock } from 'membrane';
import type { ContextStrategy, StrategyContext, ReadinessState, MessageStoreView, ContextLogView, TokenBudget, ContextEntry, StoredMessage, SourceRelation } from '../src/types/index.js';

const TEST_STORE_PATH = './test-context-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

describe('ContextManager', () => {
  before(() => cleanup());
  after(() => cleanup());

  describe('Basic Operations', () => {
    it('should create a context manager', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      assert.ok(manager);
      const stats = manager.stats();
      assert.strictEqual(stats.messageCount, 0);
      assert.strictEqual(stats.contextEntryCount, 0);
    });

    it('should add messages', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      const content: ContentBlock[] = [{ type: 'text', text: 'Hello, world!' }];
      const id = manager.addMessage('User', content);

      assert.ok(id);
      const stats = manager.stats();
      assert.strictEqual(stats.messageCount, 1);

      const message = manager.getMessage(id);
      assert.ok(message);
      assert.strictEqual(message.participant, 'User');
      assert.strictEqual(message.content.length, 1);
      assert.strictEqual(message.content[0].type, 'text');
      if (message.content[0].type === 'text') {
        assert.strictEqual(message.content[0].text, 'Hello, world!');
      }
    });

    it('should add multiple messages', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      manager.addMessage('User', [{ type: 'text', text: 'Hello' }]);
      manager.addMessage('Claude', [{ type: 'text', text: 'Hi there!' }]);
      manager.addMessage('User', [{ type: 'text', text: 'How are you?' }]);

      const stats = manager.stats();
      assert.strictEqual(stats.messageCount, 3);

      const messages = manager.getAllMessages();
      assert.strictEqual(messages.length, 3);
      assert.strictEqual(messages[0].participant, 'User');
      assert.strictEqual(messages[1].participant, 'Claude');
      assert.strictEqual(messages[2].participant, 'User');
    });

    it('should edit messages', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      const id = manager.addMessage('User', [{ type: 'text', text: 'Original text' }]);

      manager.editMessage(id, [{ type: 'text', text: 'Edited text' }]);

      const message = manager.getMessage(id);
      assert.ok(message);
      if (message.content[0].type === 'text') {
        assert.strictEqual(message.content[0].text, 'Edited text');
      }
    });

    it('should remove messages', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      const id1 = manager.addMessage('User', [{ type: 'text', text: 'First' }]);
      manager.addMessage('User', [{ type: 'text', text: 'Second' }]);

      assert.strictEqual(manager.stats().messageCount, 2);

      manager.removeMessage(id1);

      assert.strictEqual(manager.stats().messageCount, 1);
      // After removal, the remaining message should still be accessible
      const remaining = manager.getAllMessages();
      assert.strictEqual(remaining.length, 1);
      if (remaining[0].content[0].type === 'text') {
        assert.strictEqual(remaining[0].content[0].text, 'Second');
      }
    });
  });

  describe('Context Compilation', () => {
    it('should compile context with PassthroughStrategy', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: new PassthroughStrategy(),
      });

      manager.addMessage('User', [{ type: 'text', text: 'Hello' }]);
      manager.addMessage('Claude', [{ type: 'text', text: 'Hi!' }]);

      const messages = await manager.compile();

      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0].participant, 'User');
      assert.strictEqual(messages[1].participant, 'Claude');
    });

    it('should respect token budget in compilation', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: new PassthroughStrategy(),
      });

      // Add many messages
      for (let i = 0; i < 100; i++) {
        manager.addMessage('User', [{ type: 'text', text: 'Message '.repeat(100) }]);
      }

      // Compile with a small budget
      const messages = await manager.compile({
        maxTokens: 1000,
        reserveForResponse: 200,
      });

      // Should have fewer messages than we added
      assert.ok(messages.length < 100);
      assert.ok(messages.length > 0);
    });

    it('should report readiness', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: new PassthroughStrategy(),
      });

      // Passthrough is always ready
      assert.strictEqual(manager.isReady(), true);
      assert.strictEqual(manager.getPendingWork(), null);
    });
  });

  describe('Branching', () => {
    it('should list branches', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      const branches = manager.listBranches();
      assert.ok(branches.length >= 1); // Should have at least 'main'
    });

    it('should get current branch', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      const branch = manager.currentBranch();
      assert.ok(branch.name);
      assert.ok(branch.id);
    });

    it('should branch at specific message sequence (time-travel)', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      // Add several messages to create history
      const id1 = manager.addMessage('Alice', [{ type: 'text', text: 'Message 1' }]);
      const id2 = manager.addMessage('Alice', [{ type: 'text', text: 'Message 2' }]);
      const id3 = manager.addMessage('Bot', [{ type: 'text', text: 'Message 3' }]);
      const id4 = manager.addMessage('Alice', [{ type: 'text', text: 'Message 4' }]);
      const id5 = manager.addMessage('Bot', [{ type: 'text', text: 'Message 5' }]);

      // Get the sequence of message 2 (we'll branch at this point)
      const msg2 = manager.getMessage(id2);
      assert.ok(msg2, 'Message 2 should exist');
      const msg2Sequence = msg2!.sequence;

      // Branch at message 2
      const branchId = manager.branchAt(id2, 'time-travel-test');

      // Verify the branch was created with correct branch point
      const branches = manager.listBranches();
      const newBranch = branches.find(b => b.name === 'time-travel-test');
      assert.ok(newBranch, 'Time-travel branch should exist');
      assert.strictEqual(newBranch!.branchPoint, msg2Sequence, 'Branch point should equal message 2 sequence');
    });
  });

  describe('AutobiographicalStrategy', () => {
    it('should initialize without errors', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 1000,
        recentWindowTokens: 5000,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      assert.ok(manager);
      assert.strictEqual(manager.getStrategy().name, 'autobiographical');
    });

    it('should compile with recent messages when no compression needed', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 1000,
        recentWindowTokens: 50000, // Large window, no compression
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      manager.addMessage('User', [{ type: 'text', text: 'Hello' }]);
      manager.addMessage('Claude', [{ type: 'text', text: 'Hi!' }]);

      const messages = await manager.compile();

      // Should include our messages
      assert.ok(messages.length >= 2);
    });
  });

  describe('Persistence', () => {
    it('should persist messages across sessions', async () => {
      // Use a unique path for this test to avoid conflicts
      const persistPath = './test-persist-store';
      if (existsSync(persistPath)) {
        rmSync(persistPath, { recursive: true, force: true });
      }

      // Create and add messages
      const manager = await ContextManager.open({
        path: persistPath,
      });

      manager.addMessage('User', [{ type: 'text', text: 'Persisted message' }]);
      manager.sync();
      manager.close();

      // Reopen and check
      const manager2 = await ContextManager.open({
        path: persistPath,
      });

      const messages = manager2.getAllMessages();
      assert.strictEqual(messages.length, 1);
      if (messages[0].content[0].type === 'text') {
        assert.strictEqual(messages[0].content[0].text, 'Persisted message');
      }

      manager2.close();

      // Cleanup
      rmSync(persistPath, { recursive: true, force: true });
    });
  });

  describe('Edit Propagation', () => {
    /**
     * Strategy that populates context log with mixed source relations for testing.
     */
    class TestPropagationStrategy implements ContextStrategy {
      readonly name = 'test-propagation';
      private contextLog: ContextLog | null = null;

      setContextLog(log: ContextLog): void {
        this.contextLog = log;
      }

      checkReadiness(): ReadinessState {
        return { ready: true };
      }

      async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
        // Don't add automatically - tests will add entries manually
      }

      select(store: MessageStoreView, log: ContextLogView, budget: TokenBudget): ContextEntry[] {
        return log.getAll();
      }

      // Public method for tests to add entries with specific relations
      addEntry(
        participant: string,
        content: ContentBlock[],
        sourceMessageId: string,
        sourceRelation: SourceRelation
      ): void {
        if (!this.contextLog) throw new Error('Context log not set');
        this.contextLog.append(participant, content, sourceMessageId, sourceRelation);
      }
    }

    it('should propagate edits to copy entries', async () => {
      cleanup();
      const storePath = './test-propagation-store-1';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      // Create store and set up context log manually
      const store = JsStore.openOrCreate({ path: storePath });
      try {
        MessageStore.register(store);
      } catch {}
      try {
        ContextLog.register(store);
      } catch {}

      const messageStore = new MessageStore(store);
      const contextLog = new ContextLog(store);

      // Add a message
      const msg = messageStore.append('User', [{ type: 'text', text: 'Original text' }]);

      // Add context entry with 'copy' relation
      contextLog.append('User', [{ type: 'text', text: 'Original text' }], msg.id, 'copy');

      // Edit the message in message store
      messageStore.edit(msg.id, [{ type: 'text', text: 'Edited text' }]);

      // Manually trigger propagation (simulating what ContextManager does)
      const entries = contextLog.findBySource(msg.id);
      for (const entry of entries) {
        if (entry.sourceRelation === 'copy') {
          contextLog.edit(entry.index, [{ type: 'text', text: 'Edited text' }]);
        }
      }

      // Verify context log was updated
      const updatedEntry = contextLog.get(0);
      assert.ok(updatedEntry);
      assert.strictEqual(updatedEntry.content[0].type, 'text');
      if (updatedEntry.content[0].type === 'text') {
        assert.strictEqual(updatedEntry.content[0].text, 'Edited text');
      }

      store.close();
      rmSync(storePath, { recursive: true, force: true });
    });

    it('should NOT propagate edits to derived entries', async () => {
      cleanup();
      const storePath = './test-propagation-store-2';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      const store = JsStore.openOrCreate({ path: storePath });
      try {
        MessageStore.register(store);
      } catch {}
      try {
        ContextLog.register(store);
      } catch {}

      const messageStore = new MessageStore(store);
      const contextLog = new ContextLog(store);

      // Add a message
      const msg = messageStore.append('User', [{ type: 'text', text: 'Original text' }]);

      // Add context entry with 'derived' relation (like a compression summary)
      contextLog.append('User', [{ type: 'text', text: 'Summary of original' }], msg.id, 'derived');

      // Edit the message in message store
      messageStore.edit(msg.id, [{ type: 'text', text: 'Edited text' }]);

      // Propagation logic - should NOT update derived entries
      const entries = contextLog.findBySource(msg.id);
      for (const entry of entries) {
        if (entry.sourceRelation === 'copy') {
          contextLog.edit(entry.index, [{ type: 'text', text: 'Edited text' }]);
        }
        // 'derived' entries are intentionally skipped
      }

      // Verify context log was NOT updated (derived entries stay stale)
      const unchangedEntry = contextLog.get(0);
      assert.ok(unchangedEntry);
      assert.strictEqual(unchangedEntry.content[0].type, 'text');
      if (unchangedEntry.content[0].type === 'text') {
        assert.strictEqual(unchangedEntry.content[0].text, 'Summary of original');
      }

      store.close();
      rmSync(storePath, { recursive: true, force: true });
    });

    it('should NOT propagate edits to referenced entries', async () => {
      cleanup();
      const storePath = './test-propagation-store-3';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      const store = JsStore.openOrCreate({ path: storePath });
      try {
        MessageStore.register(store);
      } catch {}
      try {
        ContextLog.register(store);
      } catch {}

      const messageStore = new MessageStore(store);
      const contextLog = new ContextLog(store);

      // Add a message
      const msg = messageStore.append('User', [{ type: 'text', text: 'Original text' }]);

      // Add context entry with 'referenced' relation
      contextLog.append('User', [{ type: 'text', text: 'Mentions the original' }], msg.id, 'referenced');

      // Edit the message in message store
      messageStore.edit(msg.id, [{ type: 'text', text: 'Edited text' }]);

      // Propagation logic - should NOT update referenced entries
      const entries = contextLog.findBySource(msg.id);
      for (const entry of entries) {
        if (entry.sourceRelation === 'copy') {
          contextLog.edit(entry.index, [{ type: 'text', text: 'Edited text' }]);
        }
        // 'referenced' entries are intentionally skipped
      }

      // Verify context log was NOT updated
      const unchangedEntry = contextLog.get(0);
      assert.ok(unchangedEntry);
      assert.strictEqual(unchangedEntry.content[0].type, 'text');
      if (unchangedEntry.content[0].type === 'text') {
        assert.strictEqual(unchangedEntry.content[0].text, 'Mentions the original');
      }

      store.close();
      rmSync(storePath, { recursive: true, force: true });
    });

    it('should handle mixed source relations correctly', async () => {
      cleanup();
      const storePath = './test-propagation-store-4';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      const store = JsStore.openOrCreate({ path: storePath });
      try {
        MessageStore.register(store);
      } catch {}
      try {
        ContextLog.register(store);
      } catch {}

      const messageStore = new MessageStore(store);
      const contextLog = new ContextLog(store);

      // Add a message
      const msg = messageStore.append('User', [{ type: 'text', text: 'Original text' }]);

      // Add multiple context entries with different relations
      contextLog.append('User', [{ type: 'text', text: 'Copy of original' }], msg.id, 'copy');
      contextLog.append('Claude', [{ type: 'text', text: 'Summary of original' }], msg.id, 'derived');
      contextLog.append('System', [{ type: 'text', text: 'References original' }], msg.id, 'referenced');

      // Edit the message
      messageStore.edit(msg.id, [{ type: 'text', text: 'Edited text' }]);

      // Propagate (simulating ContextManager logic)
      const entries = contextLog.findBySource(msg.id);
      for (const entry of entries) {
        if (entry.sourceRelation === 'copy') {
          contextLog.edit(entry.index, [{ type: 'text', text: 'Edited text' }]);
        }
      }

      // Verify: copy was updated, others were not
      const copyEntry = contextLog.get(0);
      const derivedEntry = contextLog.get(1);
      const referencedEntry = contextLog.get(2);

      assert.ok(copyEntry);
      assert.ok(derivedEntry);
      assert.ok(referencedEntry);

      if (copyEntry.content[0].type === 'text') {
        assert.strictEqual(copyEntry.content[0].text, 'Edited text', 'copy should be updated');
      }
      if (derivedEntry.content[0].type === 'text') {
        assert.strictEqual(derivedEntry.content[0].text, 'Summary of original', 'derived should NOT be updated');
      }
      if (referencedEntry.content[0].type === 'text') {
        assert.strictEqual(referencedEntry.content[0].text, 'References original', 'referenced should NOT be updated');
      }

      store.close();
      rmSync(storePath, { recursive: true, force: true });
    });
  });

  describe('Index Consistency', () => {
    it('should maintain correct idToIndex mapping after removals', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      // Add multiple messages
      const id1 = manager.addMessage('User', [{ type: 'text', text: 'First' }]);
      const id2 = manager.addMessage('User', [{ type: 'text', text: 'Second' }]);
      const id3 = manager.addMessage('User', [{ type: 'text', text: 'Third' }]);

      assert.strictEqual(manager.stats().messageCount, 3);

      // Remove the middle message
      manager.removeMessage(id2);

      assert.strictEqual(manager.stats().messageCount, 2);

      // Verify we can still access the remaining messages by ID
      const msg1 = manager.getMessage(id1);
      const msg3 = manager.getMessage(id3);

      assert.ok(msg1);
      assert.ok(msg3);

      if (msg1.content[0].type === 'text') {
        assert.strictEqual(msg1.content[0].text, 'First');
      }
      if (msg3.content[0].type === 'text') {
        assert.strictEqual(msg3.content[0].text, 'Third');
      }

      // Removed message should not be found
      const msg2 = manager.getMessage(id2);
      assert.strictEqual(msg2, null);

      manager.close();
    });

    it('should rebuild source index after context log removals', async () => {
      cleanup();
      const storePath = './test-index-store';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      const store = JsStore.openOrCreate({ path: storePath });
      try {
        MessageStore.register(store);
      } catch {}
      try {
        ContextLog.register(store);
      } catch {}

      const messageStore = new MessageStore(store);
      const contextLog = new ContextLog(store);

      // Add messages
      const msg1 = messageStore.append('User', [{ type: 'text', text: 'First' }]);
      const msg2 = messageStore.append('User', [{ type: 'text', text: 'Second' }]);

      // Add context entries
      contextLog.append('User', [{ type: 'text', text: 'First' }], msg1.id, 'copy');
      contextLog.append('User', [{ type: 'text', text: 'Second' }], msg2.id, 'copy');

      // Verify initial state
      let entries1 = contextLog.findBySource(msg1.id);
      let entries2 = contextLog.findBySource(msg2.id);
      assert.strictEqual(entries1.length, 1);
      assert.strictEqual(entries2.length, 1);

      // Remove first entry
      contextLog.remove(0);

      // Source index should be rebuilt correctly
      entries1 = contextLog.findBySource(msg1.id);
      entries2 = contextLog.findBySource(msg2.id);

      // After removal, msg1's entry is gone
      assert.strictEqual(entries1.length, 0);
      // msg2's entry still exists (though index may have changed)
      // Note: After redaction, Chronicle shifts indices
      assert.strictEqual(contextLog.length(), 1);

      store.close();
      rmSync(storePath, { recursive: true, force: true });
    });
  });

  describe('Blob Storage', () => {
    it('should store and retrieve blob content', async () => {
      cleanup();
      const storePath = './test-blob-store';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      const manager = await ContextManager.open({
        path: storePath,
      });

      // Add a message with base64 image content
      const imageData = Buffer.from('fake-image-data').toString('base64');
      const id = manager.addMessage('User', [{
        type: 'image',
        source: {
          type: 'base64',
          data: imageData,
          mediaType: 'image/png',
        },
      }]);

      // Retrieve and verify
      const message = manager.getMessage(id);
      assert.ok(message);
      assert.strictEqual(message.content.length, 1);
      assert.strictEqual(message.content[0].type, 'image');

      if (message.content[0].type === 'image' && message.content[0].source.type === 'base64') {
        assert.strictEqual(message.content[0].source.data, imageData);
        assert.strictEqual(message.content[0].source.mediaType, 'image/png');
      }

      manager.close();
      rmSync(storePath, { recursive: true, force: true });
    });

    it('should deduplicate identical blobs', async () => {
      cleanup();
      const storePath = './test-blob-dedup';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      const store = JsStore.openOrCreate({ path: storePath });
      try {
        MessageStore.register(store);
      } catch {}

      const messageStore = new MessageStore(store);

      // Same image data
      const imageData = Buffer.from('identical-image-data').toString('base64');

      // Add two messages with identical images
      messageStore.append('User', [{
        type: 'image',
        source: {
          type: 'base64',
          data: imageData,
          mediaType: 'image/png',
        },
      }]);

      messageStore.append('User', [{
        type: 'image',
        source: {
          type: 'base64',
          data: imageData,
          mediaType: 'image/png',
        },
      }]);

      // Check blob count - should be 1 due to deduplication (by hash)
      const stats = store.stats();
      assert.strictEqual(stats.blobCount, 1, 'Identical blobs should be deduplicated');

      store.close();
      rmSync(storePath, { recursive: true, force: true });
    });
  });

  describe('Autobiographical Chunk Stability', () => {
    it('should maintain chunk boundaries after adding more messages', async () => {
      cleanup();
      const storePath = './test-chunk-stability';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      // Use very small chunk size to trigger chunking with few messages
      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 100,  // Very small - will trigger chunking quickly
        recentWindowTokens: 200, // Small recent window
      });

      const manager = await ContextManager.open({
        path: storePath,
        strategy,
      });

      // Add enough messages to create at least one chunk outside recent window
      // Each message ~25 tokens (100 chars / 4), need >100 tokens to chunk, >200 for outside recent
      for (let i = 0; i < 20; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Message ${i}: ${'x'.repeat(100)}` }]);
        manager.addMessage('Claude', [{ type: 'text', text: `Response ${i}: ${'y'.repeat(100)}` }]);
      }

      // Get initial message IDs
      const initialMessages = manager.getAllMessages();
      const initialIds = initialMessages.map(m => m.id);

      // Compile to see initial state (this triggers rebuildChunks)
      const initialCompiled = await manager.compile();
      const initialCompiledCount = initialCompiled.length;

      // Add more messages
      for (let i = 20; i < 30; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Message ${i}: ${'x'.repeat(100)}` }]);
        manager.addMessage('Claude', [{ type: 'text', text: `Response ${i}: ${'y'.repeat(100)}` }]);
      }

      // Compile again
      const secondCompiled = await manager.compile();

      // The original messages should still have the same IDs
      const afterMessages = manager.getAllMessages();
      for (let i = 0; i < initialIds.length; i++) {
        const found = afterMessages.find(m => m.id === initialIds[i]);
        assert.ok(found, `Original message ${i} should still exist with same ID`);
      }

      // Should have more messages now
      assert.ok(afterMessages.length > initialMessages.length);

      manager.close();
      rmSync(storePath, { recursive: true, force: true });
    });

    it('should preserve compressed chunks when adding new messages', async () => {
      // This test verifies that compressed chunk summaries remain stable
      // when new messages are added (the chunk key is based on message IDs)
      cleanup();
      const storePath = './test-chunk-preserve';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      // Without a real membrane, we can't actually compress, but we can verify
      // the chunk boundary logic by checking that rebuildChunks preserves state
      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
      });

      const manager = await ContextManager.open({
        path: storePath,
        strategy,
      });

      // Add initial messages
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(manager.addMessage('User', [{ type: 'text', text: `Message ${i}: test content here` }]));
      }

      // First compile establishes chunk boundaries
      await manager.compile();

      // Add more messages
      for (let i = 10; i < 15; i++) {
        ids.push(manager.addMessage('User', [{ type: 'text', text: `Message ${i}: more content` }]));
      }

      // Second compile should maintain old chunk boundaries
      await manager.compile();

      // All original messages should still be accessible
      for (let i = 0; i < 10; i++) {
        const msg = manager.getMessage(ids[i]);
        assert.ok(msg, `Message ${i} should still be accessible`);
      }

      manager.close();
      rmSync(storePath, { recursive: true, force: true });
    });
  });

  describe('App-Owned Store', () => {
    it('should work with an app-provided store', async () => {
      cleanup();
      const storePath = './test-app-owned-store';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      // App creates and owns the store
      const store = JsStore.openOrCreate({ path: storePath });

      // App registers its own state (snapshot strategy for simple key-value)
      store.registerState({ id: 'app-state', strategy: 'snapshot' });

      // Pass to context manager
      const manager = await ContextManager.open({
        store,
        strategy: new PassthroughStrategy(),
      });

      // Context manager works
      manager.addMessage('User', [{ type: 'text', text: 'Hello' }]);
      const compiled = await manager.compile();
      assert.strictEqual(compiled.length, 1);

      // App can use its own state via the store
      store.setStateJson('app-state', { lastTool: 'web_search' });
      const appState = store.getStateJson('app-state');
      assert.ok(appState);
      assert.strictEqual((appState as any).lastTool, 'web_search');

      // manager.close() should NOT close the store (app owns it)
      manager.close();
      assert.strictEqual(store.isClosed(), false);

      // App closes the store when done
      store.close();
      assert.strictEqual(store.isClosed(), true);

      rmSync(storePath, { recursive: true, force: true });
    });

    it('should allow access to store via getStore()', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
      });

      const store = manager.getStore();
      assert.ok(store);

      // Can register additional states
      try {
        store.registerState({ id: 'additional-state', strategy: 'snapshot' });
      } catch {
        // May already exist
      }

      // manager.close() SHOULD close the store (manager owns it)
      manager.close();
      assert.strictEqual(store.isClosed(), true);
    });
  });

  describe('Multi-Agent Namespacing', () => {
    it('should support multiple agents sharing messages with separate context logs', async () => {
      cleanup();
      const storePath = './test-multi-agent';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      // Create shared store
      const store = JsStore.openOrCreate({ path: storePath });

      // Create two agents with different namespaces
      const agentAlpha = await ContextManager.open({
        store,
        namespace: 'alpha',
        strategy: new PassthroughStrategy(),
      });

      const agentBeta = await ContextManager.open({
        store,
        namespace: 'beta',
        strategy: new PassthroughStrategy(),
      });

      // Add message via agent alpha
      const msgId = agentAlpha.addMessage('User', [{ type: 'text', text: 'Hello agents!' }]);

      // Both agents should see the same message (shared message store)
      const alphaMessages = agentAlpha.getAllMessages();
      const betaMessages = agentBeta.getAllMessages();
      assert.strictEqual(alphaMessages.length, 1);
      assert.strictEqual(betaMessages.length, 1);
      assert.strictEqual(alphaMessages[0].id, betaMessages[0].id);

      // Add message via agent beta
      agentBeta.addMessage('Claude', [{ type: 'text', text: 'Hello from beta!' }]);

      // Both should see both messages
      assert.strictEqual(agentAlpha.getAllMessages().length, 2);
      assert.strictEqual(agentBeta.getAllMessages().length, 2);

      // Compile - each agent has its own context
      const alphaCompiled = await agentAlpha.compile();
      const betaCompiled = await agentBeta.compile();

      // Both see the same messages in their compiled context
      assert.strictEqual(alphaCompiled.length, 2);
      assert.strictEqual(betaCompiled.length, 2);

      // Context logs are separate - verified by the fact that both work independently

      agentAlpha.close();
      agentBeta.close();
      store.close();

      rmSync(storePath, { recursive: true, force: true });
    });

    it('should isolate context log entries between namespaced agents', async () => {
      cleanup();
      const storePath = './test-multi-agent-isolation';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      const store = JsStore.openOrCreate({ path: storePath });

      // Use AutobiographicalStrategy with different settings per agent
      const agentAlpha = await ContextManager.open({
        store,
        namespace: 'alpha',
        strategy: new AutobiographicalStrategy({
          targetChunkTokens: 100,
          recentWindowTokens: 500,
        }),
      });

      const agentBeta = await ContextManager.open({
        store,
        namespace: 'beta',
        strategy: new AutobiographicalStrategy({
          targetChunkTokens: 200,
          recentWindowTokens: 1000,
        }),
      });

      // Add shared messages
      for (let i = 0; i < 5; i++) {
        agentAlpha.addMessage('User', [{ type: 'text', text: `Message ${i}` }]);
      }

      // Both see all messages
      assert.strictEqual(agentAlpha.getAllMessages().length, 5);
      assert.strictEqual(agentBeta.getAllMessages().length, 5);

      // Each compiles with its own strategy settings
      const alphaCompiled = await agentAlpha.compile();
      const betaCompiled = await agentBeta.compile();

      // Both should compile successfully
      assert.ok(alphaCompiled.length > 0);
      assert.ok(betaCompiled.length > 0);

      agentAlpha.close();
      agentBeta.close();
      store.close();

      rmSync(storePath, { recursive: true, force: true });
    });
  });

  describe('Compression Failure Recovery', () => {
    it('should handle LLM failures gracefully and allow retry', async () => {
      cleanup();
      const storePath = './test-compression-fail';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      // Mock membrane that tracks calls and can be configured to fail
      let callCount = 0;
      let shouldFail = true;
      const mockMembrane = {
        complete: async () => {
          callCount++;
          if (shouldFail) {
            throw new Error('Simulated LLM failure');
          }
          return {
            content: [{ type: 'text', text: 'Summary of the conversation chunk' }],
          };
        },
      };

      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
      });

      const manager = await ContextManager.open({
        path: storePath,
        strategy,
        membrane: mockMembrane as any,
      });

      // Add enough messages to create a chunk that needs compression
      for (let i = 0; i < 15; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Message ${i}: ${'x'.repeat(50)}` }]);
      }

      // Strategy should not be ready (has pending compression)
      // Note: It might be ready if no chunks were formed yet, so we compile first
      await manager.compile();

      // Try tick which attempts compression - should fail
      if (!manager.isReady()) {
        try {
          await manager.tick();
        } catch (e) {
          // Expected to fail
          assert.ok(e instanceof Error);
          assert.strictEqual((e as Error).message, 'Simulated LLM failure');
        }
      }

      // System should still be functional
      const messages = manager.getAllMessages();
      assert.strictEqual(messages.length, 15);

      // Can still compile (uses uncompressed chunks + recent window)
      const compiled = await manager.compile();
      assert.ok(compiled.length > 0);

      // Now allow success
      shouldFail = false;

      // Retry compression
      if (!manager.isReady()) {
        await manager.tick();
      }

      // Should still work
      const recompiled = await manager.compile();
      assert.ok(recompiled.length > 0);

      manager.close();
      rmSync(storePath, { recursive: true, force: true });
    });

    it('should not mark chunk as compressed after failure', async () => {
      cleanup();
      const storePath = './test-compression-state';
      if (existsSync(storePath)) {
        rmSync(storePath, { recursive: true, force: true });
      }

      // Mock membrane that always fails
      const mockMembrane = {
        complete: async () => {
          throw new Error('Always fails');
        },
      };

      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 50,
        recentWindowTokens: 25,
      });

      const manager = await ContextManager.open({
        path: storePath,
        strategy,
        membrane: mockMembrane as any,
      });

      // Add messages
      for (let i = 0; i < 10; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Message ${i}` }]);
      }

      // Compile to trigger chunk analysis
      await manager.compile();

      // Try tick multiple times - should keep failing but not corrupt state
      for (let i = 0; i < 3; i++) {
        if (!manager.isReady()) {
          try {
            await manager.tick();
          } catch {
            // Expected
          }
        }
      }

      // Messages should still be intact
      const messages = manager.getAllMessages();
      assert.strictEqual(messages.length, 10);

      // Compile should still work (falls back to uncompressed)
      const compiled = await manager.compile();
      assert.ok(compiled.length > 0);

      manager.close();
      rmSync(storePath, { recursive: true, force: true });
    });
  });
});

// Run with: node --test dist/test/integration.test.js
