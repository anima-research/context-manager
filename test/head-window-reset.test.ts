/**
 * Tests for the resettable head window / topic transition feature.
 *
 * Covers:
 * - resetHeadWindow() shifts the head window anchor
 * - getHeadWindowStartIndex() resolves IDs correctly
 * - selectHierarchical() excludes old head window from verbatim zone
 * - rebuildChunks() includes old head window in compressible zone
 * - isTopicTransitionMessage() detection
 * - initialize() restores headWindowStartId from persisted markers
 * - tool_use boundary retreat (if, not while)
 * - KnowledgeStrategy inherits head window reset behavior
 * - ContextManager.resetHeadWindow() public API
 * - ResettableStrategy type guard
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import {
  ContextManager,
  AutobiographicalStrategy,
  KnowledgeStrategy,
  PassthroughStrategy,
  isResettableStrategy,
} from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-head-window-reset';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

describe('Head Window Reset', () => {
  before(() => cleanup());
  after(() => cleanup());

  describe('AutobiographicalStrategy.resetHeadWindow', () => {
    it('should shift the head window to start from the specified message', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        headWindowTokens: 200,
        recentWindowTokens: 100,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Topic A messages (will be in head window initially)
      manager.addMessage('user', textBlock('Topic A: Tell me about cats'));
      manager.addMessage('assistant', textBlock('Topic A: Cats are great pets'));
      manager.addMessage('user', textBlock('Topic A: What breeds exist?'));

      // Inject transition marker
      const transitionId = manager.addMessage('Context Manager', textBlock('[Topic Transition]\n\nWe discussed cats.'));

      // Topic B messages
      manager.addMessage('user', textBlock('Topic B: Now tell me about dogs'));
      manager.addMessage('assistant', textBlock('Topic B: Dogs are loyal companions'));

      // Reset head window to start from the transition message
      strategy.resetHeadWindow(transitionId);

      const { messages } = await manager.compile();

      // Head window should start from the transition, not from Topic A
      const firstMsg = messages[0];
      assert.ok(firstMsg, 'Should have at least one message');

      // Topic A messages should NOT be the first verbatim messages
      const firstText = firstMsg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('');
      assert.ok(
        !firstText.includes('Topic A'),
        `First message should not be Topic A content, got: ${firstText.slice(0, 80)}`
      );

      // The transition marker or Topic B should be in the output
      const allText = messages.flatMap(m =>
        m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text)
      ).join('\n');
      assert.ok(allText.includes('Topic B'), 'Topic B should be in compiled output');

      manager.close();
    });

    it('should make old head window messages compressible', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        headWindowTokens: 200,
        recentWindowTokens: 50,
        targetChunkTokens: 100,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Add enough Topic A messages to fill the head window
      for (let i = 0; i < 5; i++) {
        manager.addMessage(i % 2 === 0 ? 'user' : 'assistant',
          textBlock(`Topic A message ${i}: ${'a'.repeat(50)}`));
      }

      // Transition
      const transitionId = manager.addMessage('Context Manager',
        textBlock('[Topic Transition]\n\nSummary of Topic A.'));
      strategy.resetHeadWindow(transitionId);

      // Add Topic B messages
      for (let i = 0; i < 5; i++) {
        manager.addMessage(i % 2 === 0 ? 'user' : 'assistant',
          textBlock(`Topic B message ${i}: ${'b'.repeat(50)}`));
      }

      // Compiling should work without errors — old head window is now chunkable
      const { messages } = await manager.compile();
      assert.ok(messages.length > 0, 'Should compile messages');

      manager.close();
    });
  });

  describe('getHeadWindowStartIndex', () => {
    it('should return 0 when no head window start is set', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        headWindowTokens: 200,
        recentWindowTokens: 100,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      manager.addMessage('user', textBlock('Hello'));
      manager.addMessage('assistant', textBlock('Hi'));

      // With no reset, head window starts from 0
      const { messages } = await manager.compile();
      const firstText = messages[0].content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('');
      assert.ok(firstText.includes('Hello'), 'First message should be the first one added');

      manager.close();
    });

    it('should fall back to 0 if referenced message is deleted', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        headWindowTokens: 500,
        recentWindowTokens: 100,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      manager.addMessage('user', textBlock('First'));
      const midId = manager.addMessage('assistant', textBlock('Second'));
      manager.addMessage('user', textBlock('Third'));

      // Reset to mid message, then remove it
      strategy.resetHeadWindow(midId);
      manager.removeMessage(midId);

      // Should not throw — falls back to 0
      const { messages } = await manager.compile();
      assert.ok(messages.length > 0);

      manager.close();
    });
  });

  describe('isTopicTransitionMessage detection', () => {
    it('should detect [Topic Transition] messages from Context Manager', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        headWindowTokens: 200,
        recentWindowTokens: 200,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Add regular messages
      manager.addMessage('user', textBlock('Hello'));
      manager.addMessage('assistant', textBlock('[Topic Transition] fake'));

      // Add real transition
      const realTransitionId = manager.addMessage('Context Manager',
        textBlock('[Topic Transition]\n\nReal transition.'));

      // Add another regular message
      manager.addMessage('user', textBlock('After transition'));

      manager.close();

      // Reopen — initialize should find the transition marker
      const strategy2 = new AutobiographicalStrategy({
        headWindowTokens: 200,
        recentWindowTokens: 200,
      });

      const manager2 = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: strategy2,
      });

      // The head window should start from the transition message
      const { messages } = await manager2.compile();
      const allText = messages.flatMap(m =>
        m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text)
      ).join('\n');

      // The first verbatim message should be the transition or after it,
      // NOT the initial "Hello"
      const firstText = messages[0].content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('');
      assert.ok(
        firstText.includes('Topic Transition') || firstText.includes('After transition'),
        `Expected transition or post-transition as first message, got: ${firstText.slice(0, 80)}`
      );

      manager2.close();
    });
  });

  describe('Persistence across restarts', () => {
    it('should restore headWindowStartId from topic transition markers', async () => {
      cleanup();

      // Session 1: create messages and reset head window
      const strategy1 = new AutobiographicalStrategy({
        headWindowTokens: 300,
        recentWindowTokens: 100,
      });

      const manager1 = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: strategy1,
      });

      manager1.addMessage('user', textBlock('Old topic: planning'));
      manager1.addMessage('assistant', textBlock('Old topic: sure, lets plan'));
      const transitionId = manager1.addMessage('Context Manager',
        textBlock('[Topic Transition]\n\nWe planned things.'));
      strategy1.resetHeadWindow(transitionId);
      manager1.addMessage('user', textBlock('New topic: execution'));

      manager1.sync();
      manager1.close();

      // Session 2: reopen with fresh strategy
      const strategy2 = new AutobiographicalStrategy({
        headWindowTokens: 300,
        recentWindowTokens: 100,
      });

      const manager2 = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: strategy2,
      });

      const { messages } = await manager2.compile();

      // The old topic messages should not be in the head window
      const firstText = messages[0].content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('');
      assert.ok(
        !firstText.includes('Old topic'),
        `After restart, head window should not start from old topic: ${firstText.slice(0, 80)}`
      );

      manager2.close();
    });
  });

  describe('Tool use boundary retreat', () => {
    it('should retreat at most one position for tool_use at head window boundary', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        headWindowTokens: 300,
        recentWindowTokens: 50,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Fill with tool_use/tool_result pairs that push the boundary
      manager.addMessage('user', textBlock('Start'));
      manager.addMessage('assistant', [
        { type: 'text', text: 'Tool 1' },
        { type: 'tool_use', id: 'c1', name: 'search', input: {} },
      ]);
      manager.addMessage('user', [
        { type: 'tool_result', toolUseId: 'c1', content: 'result1' },
      ]);
      manager.addMessage('assistant', [
        { type: 'text', text: 'Tool 2' },
        { type: 'tool_use', id: 'c2', name: 'search', input: {} },
      ]);
      manager.addMessage('user', [
        { type: 'tool_result', toolUseId: 'c2', content: 'result2' },
      ]);
      // Push well over the head window budget
      manager.addMessage('assistant', textBlock('x'.repeat(1000)));
      manager.addMessage('user', textBlock('End'));

      const { messages } = await manager.compile();

      // The head window should not be empty — the retreat should NOT
      // hollow out the entire head window through consecutive tool_use messages
      assert.ok(messages.length >= 2, `Should have multiple messages, got ${messages.length}`);

      // Validate no orphaned tool_use/tool_result
      for (let i = 0; i < messages.length; i++) {
        const hasToolUse = messages[i].content.some(b => b.type === 'tool_use');
        if (hasToolUse && i + 1 < messages.length) {
          const nextHasToolResult = messages[i + 1].content.some(b => b.type === 'tool_result');
          assert.ok(nextHasToolResult, 'tool_use must be followed by tool_result');
        }
      }

      manager.close();
    });
  });

  describe('KnowledgeStrategy compatibility', () => {
    it('should support head window reset on KnowledgeStrategy', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        headWindowTokens: 200,
        recentWindowTokens: 100,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      manager.addMessage('user', textBlock('Knowledge topic A'));
      manager.addMessage('assistant', textBlock('Analyzing topic A'));

      const transitionId = manager.addMessage('Context Manager',
        textBlock('[Topic Transition]\n\nTransitioned to new topic.'));
      strategy.resetHeadWindow(transitionId);

      manager.addMessage('user', textBlock('Knowledge topic B'));
      manager.addMessage('assistant', textBlock('Analyzing topic B'));

      const { messages } = await manager.compile();
      assert.ok(messages.length > 0);

      // First message should be the transition marker, not "Knowledge topic A"
      const firstText = messages[0].content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('');
      assert.ok(
        firstText.includes('[Topic Transition]') || firstText.includes('topic B'),
        `KnowledgeStrategy head should start from transition or topic B, got: ${firstText.slice(0, 80)}`
      );

      manager.close();
    });
  });

  describe('ContextManager.resetHeadWindow public API', () => {
    it('should inject transition marker and reset strategy', async () => {
      cleanup();
      const strategy = new AutobiographicalStrategy({
        headWindowTokens: 300,
        recentWindowTokens: 100,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      manager.addMessage('user', textBlock('Old context'));
      manager.addMessage('assistant', textBlock('Old response'));

      // Call public API with explicit text
      const summary = await manager.resetHeadWindow('User switched from old to new topic.');
      assert.strictEqual(summary, 'User switched from old to new topic.');

      manager.addMessage('user', textBlock('New context'));

      const { messages } = await manager.compile();

      // Transition marker should be in the output
      const allText = messages.flatMap(m =>
        m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text)
      ).join('\n');
      assert.ok(allText.includes('[Topic Transition]'), 'Should contain transition marker');
      assert.ok(allText.includes('New context'), 'Should contain new topic');

      manager.close();
    });

    it('should throw for strategies that do not support reset', async () => {
      cleanup();
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: new PassthroughStrategy(),
      });

      await assert.rejects(
        () => manager.resetHeadWindow('test'),
        { message: /does not support head window reset/ }
      );

      manager.close();
    });
  });

  describe('isResettableStrategy type guard', () => {
    it('should return true for AutobiographicalStrategy', () => {
      const strategy = new AutobiographicalStrategy();
      assert.strictEqual(isResettableStrategy(strategy), true);
    });

    it('should return true for KnowledgeStrategy', () => {
      const strategy = new KnowledgeStrategy();
      assert.strictEqual(isResettableStrategy(strategy), true);
    });

    it('should return false for PassthroughStrategy', () => {
      const strategy = new PassthroughStrategy();
      assert.strictEqual(isResettableStrategy(strategy), false);
    });
  });
});
