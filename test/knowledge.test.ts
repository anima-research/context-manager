import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, KnowledgeStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry } from '../src/types/index.js';

const TEST_STORE_PATH = './test-knowledge-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

// Helper to access protected state via the strategy instance
function getStrategyState(strategy: KnowledgeStrategy) {
  // Access protected fields for testing via property access
  const s = strategy as any;
  return {
    chunks: s.chunks as Array<{
      index: number;
      startIndex: number;
      endIndex: number;
      messages: any[];
      tokens: number;
      compressed: boolean;
      phaseType?: string;
    }>,
    summaries: s.summaries as SummaryEntry[],
    compressionQueue: s.compressionQueue as number[],
  };
}

describe('KnowledgeStrategy', () => {
  before(() => cleanup());
  after(() => cleanup());

  describe('Phase Classification', () => {
    it('should classify research tool messages as research', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        researchToolPrefixes: ['mcpl:', 'zulip:'],
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Research phase: tool_use with mcpl: prefix
      manager.addMessage('Claude', [{
        type: 'tool_use',
        id: 'tu1',
        name: 'mcpl:search',
        input: { query: 'test' },
      }]);
      manager.addMessage('User', [{
        type: 'tool_result',
        toolUseId: 'tu1',
        content: 'Found 3 results',
      }]);

      // Synthesis phase: plain dialogue
      manager.addMessage('Claude', [{ type: 'text', text: 'Based on the results...' }]);
      manager.addMessage('User', [{ type: 'text', text: 'What do you think?' }]);

      // More research
      manager.addMessage('Claude', [{
        type: 'tool_use',
        id: 'tu2',
        name: 'zulip:fetch_messages',
        input: { stream: 'general' },
      }]);
      manager.addMessage('User', [{
        type: 'tool_result',
        toolUseId: 'tu2',
        content: 'Messages fetched',
      }]);

      // Pad to push messages out of recent window
      for (let i = 0; i < 8; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding message ${i} ${'x'.repeat(20)}` }]);
      }

      // Force chunk rebuild by compiling
      await manager.compile();

      const state = getStrategyState(strategy);
      // Should have created chunks with phase types
      const researchChunks = state.chunks.filter(c => c.phaseType === 'research');
      const synthesisChunks = state.chunks.filter(c => c.phaseType === 'synthesis');

      assert.ok(researchChunks.length > 0, 'Should have at least one research chunk');
      assert.ok(synthesisChunks.length > 0, 'Should have at least one synthesis chunk');
      manager.close();
    });

    it('should classify lesson tool messages as lesson', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        lessonToolNames: ['lessons:create'],
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Lesson phase
      manager.addMessage('Claude', [{
        type: 'tool_use',
        id: 'tu1',
        name: 'lessons:create',
        input: { title: 'Test Lesson' },
      }]);
      manager.addMessage('User', [{
        type: 'tool_result',
        toolUseId: 'tu1',
        content: 'Lesson created',
      }]);

      // Pad
      for (let i = 0; i < 8; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding ${i} ${'x'.repeat(20)}` }]);
      }

      await manager.compile();
      const state = getStrategyState(strategy);
      const lessonChunks = state.chunks.filter(c => c.phaseType === 'lesson');
      assert.ok(lessonChunks.length > 0, 'Should have at least one lesson chunk');
      manager.close();
    });

    it('should classify subagent tool messages as subagent', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        subagentToolPrefixes: ['subagent:'],
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      manager.addMessage('Claude', [{
        type: 'tool_use',
        id: 'tu1',
        name: 'subagent:spawn',
        input: { task: 'research' },
      }]);
      manager.addMessage('User', [{
        type: 'tool_result',
        toolUseId: 'tu1',
        content: 'Subagent result',
      }]);

      for (let i = 0; i < 8; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding ${i} ${'x'.repeat(20)}` }]);
      }

      await manager.compile();
      const state = getStrategyState(strategy);
      const subagentChunks = state.chunks.filter(c => c.phaseType === 'subagent');
      assert.ok(subagentChunks.length > 0, 'Should have at least one subagent chunk');
      manager.close();
    });

    it('should inherit tool phase for tool_result without tool_use', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Research tool_use
      manager.addMessage('Claude', [{
        type: 'tool_use',
        id: 'tu1',
        name: 'mcpl:search',
        input: { query: 'test' },
      }]);
      // Standalone tool_result (no tool_use in same message) should inherit research
      manager.addMessage('User', [{
        type: 'tool_result',
        toolUseId: 'tu1',
        content: 'Search results',
      }]);

      for (let i = 0; i < 8; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding ${i} ${'x'.repeat(20)}` }]);
      }

      await manager.compile();
      const state = getStrategyState(strategy);
      assert.ok(state.chunks.length > 0, 'premise: a chunk formed');
      assert.strictEqual(state.chunks[0].phaseType, 'research',
        'tool_result should inherit phase from preceding tool_use');
      manager.close();
    });

    it('should classify pure dialogue as synthesis', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      manager.addMessage('User', [{ type: 'text', text: 'What do you think about X?' }]);
      manager.addMessage('Claude', [{ type: 'text', text: 'I think X is interesting because...' }]);
      manager.addMessage('User', [{ type: 'text', text: 'That makes sense. And Y?' }]);
      manager.addMessage('Claude', [{ type: 'text', text: 'Y connects to X through...' }]);

      for (let i = 0; i < 6; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding ${i} ${'x'.repeat(20)}` }]);
      }

      await manager.compile();
      const state = getStrategyState(strategy);
      const synthesisChunks = state.chunks.filter(c => c.phaseType === 'synthesis');
      assert.ok(synthesisChunks.length > 0, 'Pure dialogue should produce synthesis chunks');
      manager.close();
    });

    it('should prioritize lesson over other classifications', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 200,
        recentWindowTokens: 50,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Message with both lesson tool AND research tool — lesson should win
      manager.addMessage('Claude', [
        { type: 'tool_use', id: 'tu1', name: 'mcpl:search', input: {} },
        { type: 'tool_use', id: 'tu2', name: 'lessons:create', input: {} },
      ]);
      manager.addMessage('User', [
        { type: 'tool_result', toolUseId: 'tu1', content: 'found' },
        { type: 'tool_result', toolUseId: 'tu2', content: 'created' },
      ]);

      for (let i = 0; i < 8; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding ${i} ${'x'.repeat(20)}` }]);
      }

      await manager.compile();
      const state = getStrategyState(strategy);
      assert.ok(state.chunks.length > 0, 'premise: a chunk formed');
      assert.strictEqual(state.chunks[0].phaseType, 'lesson',
        'Lesson should take priority over research');
      manager.close();
    });
  });

  describe('Semantic Chunking', () => {
    it('should create chunk boundaries at phase transitions', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 5000, // High limit so size doesn't trigger boundaries
        recentWindowTokens: 50,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      // Research phase (3 messages)
      manager.addMessage('Claude', [{
        type: 'tool_use', id: 'tu1', name: 'mcpl:search', input: {},
      }]);
      manager.addMessage('User', [{
        type: 'tool_result', toolUseId: 'tu1', content: 'Result 1',
      }]);
      manager.addMessage('Claude', [{
        type: 'tool_use', id: 'tu2', name: 'mcpl:get', input: {},
      }]);
      manager.addMessage('User', [{
        type: 'tool_result', toolUseId: 'tu2', content: 'Result 2',
      }]);

      // Synthesis phase (transition should trigger chunk boundary)
      manager.addMessage('Claude', [{ type: 'text', text: 'Based on the research, I conclude...' }]);
      manager.addMessage('User', [{ type: 'text', text: 'Makes sense' }]);
      manager.addMessage('Claude', [{ type: 'text', text: 'Furthermore...' }]);

      // Pad to push out of recent
      for (let i = 0; i < 6; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding ${i} ${'x'.repeat(30)}` }]);
      }

      await manager.compile();
      const state = getStrategyState(strategy);

      // Should have at least 2 chunks: research + synthesis
      assert.ok(state.chunks.length >= 2,
        `Expected at least 2 chunks (research + synthesis), got ${state.chunks.length}`);

      // First chunk should be research, subsequent should include synthesis
      if (state.chunks.length >= 2) {
        const phases = state.chunks.map(c => c.phaseType);
        assert.ok(phases.includes('research'), 'Should have a research chunk');
        assert.ok(phases.includes('synthesis'), 'Should have a synthesis chunk');
      }

      manager.close();
    });
  });

  describe('Asymmetric L1 Budget', () => {
    it('should cap research summaries at configured budget fraction', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        researchL1BudgetCap: 0.3,
      });

      // Access protected selectL1Summaries via the instance
      const selectL1 = (strategy as any).selectL1Summaries.bind(strategy);

      // Create test summaries: 5 research, 5 synthesis
      const summaries: SummaryEntry[] = [];
      for (let i = 0; i < 5; i++) {
        summaries.push({
          id: `L1-r${i}`, level: 1, content: 'research summary', tokens: 100,
          sourceLevel: 0, sourceIds: [`m${i}`],
          sourceRange: { first: `m${i}`, last: `m${i}` },
          created: Date.now(), phaseType: 'research',
        });
      }
      for (let i = 0; i < 5; i++) {
        summaries.push({
          id: `L1-s${i}`, level: 1, content: 'synthesis summary', tokens: 100,
          sourceLevel: 0, sourceIds: [`m${i + 5}`],
          sourceRange: { first: `m${i + 5}`, last: `m${i + 5}` },
          created: Date.now(), phaseType: 'synthesis',
        });
      }

      const { selected, tokensUsed } = selectL1(summaries, 1000, 1000);

      // Research should be capped at 30% of 1000 = 300 tokens = max 3 entries
      const researchSelected = selected.filter((s: SummaryEntry) => s.phaseType === 'research');
      const researchTokens = researchSelected.reduce((sum: number, s: SummaryEntry) => sum + s.tokens, 0);

      assert.ok(researchTokens <= 300,
        `Research tokens (${researchTokens}) should not exceed 30% cap (300)`);
      assert.ok(researchSelected.length <= 3,
        `Research entries (${researchSelected.length}) should be capped`);

      manager_close_noop();
    });

    it('should guarantee synthesis floor', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        synthesisL1BudgetFloor: 0.4,
      });

      const selectL1 = (strategy as any).selectL1Summaries.bind(strategy);

      // Synthesis entries that together exceed the floor
      const summaries: SummaryEntry[] = [];
      for (let i = 0; i < 10; i++) {
        summaries.push({
          id: `L1-s${i}`, level: 1, content: 'synthesis', tokens: 100,
          sourceLevel: 0, sourceIds: [`m${i}`],
          sourceRange: { first: `m${i}`, last: `m${i}` },
          created: Date.now(), phaseType: 'synthesis',
        });
      }

      const { selected, tokensUsed } = selectL1(summaries, 1000, 1000);

      // Floor is 40% = 400. With 100-token entries, at least 4 should be selected
      const synthesisSelected = selected.filter((s: SummaryEntry) => s.phaseType === 'synthesis');
      assert.ok(synthesisSelected.length >= 4,
        `Should include at least 4 synthesis entries (floor=400, each=100), got ${synthesisSelected.length}`);

      manager_close_noop();
    });

    it('should cap synthesis at configured cap', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        synthesisL1BudgetFloor: 0.4,
        synthesisL1BudgetCap: 0.7,
      });

      const selectL1 = (strategy as any).selectL1Summaries.bind(strategy);

      // Many synthesis entries
      const summaries: SummaryEntry[] = [];
      for (let i = 0; i < 15; i++) {
        summaries.push({
          id: `L1-s${i}`, level: 1, content: 'synthesis', tokens: 100,
          sourceLevel: 0, sourceIds: [`m${i}`],
          sourceRange: { first: `m${i}`, last: `m${i}` },
          created: Date.now(), phaseType: 'synthesis',
        });
      }

      const { selected, tokensUsed } = selectL1(summaries, 1000, 1000);

      // Cap is 70% = 700. With 100-token entries, should select at most 7
      assert.ok(selected.length <= 7,
        `Synthesis should be capped at 70% (max 7 entries), got ${selected.length}`);

      manager_close_noop();
    });

    it('should prioritize synthesis over research', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        researchL1BudgetCap: 0.3,
        synthesisL1BudgetFloor: 0.4,
      });

      const selectL1 = (strategy as any).selectL1Summaries.bind(strategy);

      // Interleaved: synthesis, research, lesson
      const summaries: SummaryEntry[] = [
        // Synthesis
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `L1-s${i}`, level: 1 as const, content: 'synthesis', tokens: 200,
          sourceLevel: 0 as const, sourceIds: [`ms${i}`],
          sourceRange: { first: `ms${i}`, last: `ms${i}` },
          created: Date.now(), phaseType: 'synthesis',
        })),
        // Research
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `L1-r${i}`, level: 1 as const, content: 'research', tokens: 200,
          sourceLevel: 0 as const, sourceIds: [`mr${i}`],
          sourceRange: { first: `mr${i}`, last: `mr${i}` },
          created: Date.now(), phaseType: 'research',
        })),
        // Lessons
        ...Array.from({ length: 2 }, (_, i) => ({
          id: `L1-l${i}`, level: 1 as const, content: 'lesson', tokens: 100,
          sourceLevel: 0 as const, sourceIds: [`ml${i}`],
          sourceRange: { first: `ml${i}`, last: `ml${i}` },
          created: Date.now(), phaseType: 'lesson',
        })),
      ];

      // Budget = 1000
      const { selected } = selectL1(summaries, 1000, 1000);

      // Synthesis should come first (priority 1)
      const synthesisCount = selected.filter((s: SummaryEntry) => s.phaseType === 'synthesis').length;
      const researchCount = selected.filter((s: SummaryEntry) => s.phaseType === 'research').length;
      const lessonCount = selected.filter((s: SummaryEntry) => s.phaseType === 'lesson').length;

      assert.ok(synthesisCount > 0, 'Synthesis should be selected');
      assert.ok(lessonCount > 0, 'Lessons should be selected (high priority)');
      // Research capped at 30% of 1000 = 300, each is 200, so max 1
      assert.ok(researchCount <= 1,
        `Research (${researchCount}) should be capped by 30% budget`);

      manager_close_noop();
    });
  });

  describe('Compression Prompts', () => {
    it('should produce phase-specific compression instructions', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
      });

      const getInstruction = (strategy as any).getCompressionInstruction.bind(strategy);

      const researchChunk = { phaseType: 'research' };
      const synthesisChunk = { phaseType: 'synthesis' };
      const lessonChunk = { phaseType: 'lesson' };
      const subagentChunk = { phaseType: 'subagent' };

      const researchInstr = getInstruction(researchChunk, 2000);
      const synthesisInstr = getInstruction(synthesisChunk, 2000);
      const lessonInstr = getInstruction(lessonChunk, 2000);
      const subagentInstr = getInstruction(subagentChunk, 2000);

      // Each should be different
      assert.notStrictEqual(researchInstr, synthesisInstr);
      assert.notStrictEqual(synthesisInstr, lessonInstr);
      assert.notStrictEqual(lessonInstr, subagentInstr);

      // Each should mention its domain
      assert.ok(researchInstr.includes('research'), 'Research instruction should mention research');
      assert.ok(synthesisInstr.includes('reasoning') || synthesisInstr.includes('conclusions'),
        'Synthesis instruction should mention reasoning/conclusions');
      assert.ok(lessonInstr.includes('lesson') || lessonInstr.includes('knowledge'),
        'Lesson instruction should mention lessons/knowledge');
      assert.ok(subagentInstr.includes('subagent'),
        'Subagent instruction should mention subagent');

      // All should mention [LEAD]
      assert.ok(researchInstr.includes('[LEAD]'));
      assert.ok(synthesisInstr.includes('[LEAD]'));
      assert.ok(lessonInstr.includes('[LEAD]'));
      assert.ok(subagentInstr.includes('[LEAD]'));

      manager_close_noop();
    });

    it('should keep the [LEAD] instruction in merge instructions', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
      });

      const getMerge = (strategy as any).getMergeInstruction.bind(strategy);

      const sources: SummaryEntry[] = [
        { id: 'L1-0', level: 1, content: '', tokens: 100, sourceLevel: 0,
          sourceIds: ['m0'], sourceRange: { first: 'm0', last: 'm0' },
          created: Date.now(), phaseType: 'research' },
        { id: 'L1-1', level: 1, content: '', tokens: 100, sourceLevel: 0,
          sourceIds: ['m1'], sourceRange: { first: 'm1', last: 'm1' },
          created: Date.now(), phaseType: 'research' },
        { id: 'L1-2', level: 1, content: '', tokens: 100, sourceLevel: 0,
          sourceIds: ['m2'], sourceRange: { first: 'm2', last: 'm2' },
          created: Date.now(), phaseType: 'synthesis' },
      ];

      const instruction = getMerge(2, sources, 2000);

      assert.ok(instruction.includes('[LEAD]'), 'Should preserve LEAD instruction');

      manager_close_noop();
    });
  });

  describe('Constructor Type Safety', () => {
    it('should classify by the tool prefixes and names it is given', async () => {
      cleanup();
      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 5000,
        recentWindowTokens: 50,
        researchToolPrefixes: ['custom:'],
        subagentToolPrefixes: ['agent:'],
        lessonToolNames: ['learn:save'],
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const call = (id: string, name: string): void => {
        manager.addMessage('Claude', [{ type: 'tool_use', id, name, input: {} }]);
        manager.addMessage('User', [{ type: 'tool_result', toolUseId: id, content: `Result ${id}` }]);
      };
      call('tu1', 'custom:find');
      manager.addMessage('Claude', [{ type: 'text', text: 'Based on that, I conclude...' }]);
      manager.addMessage('User', [{ type: 'text', text: 'Makes sense' }]);
      call('tu2', 'agent:spawn');
      manager.addMessage('Claude', [{ type: 'text', text: 'The agent reported back.' }]);
      manager.addMessage('User', [{ type: 'text', text: 'Good' }]);
      call('tu3', 'learn:save');
      for (let i = 0; i < 10; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Padding ${i} ${'x'.repeat(40)}` }]);
      }

      await manager.compile();
      const phases = getStrategyState(strategy).chunks.map(c => c.phaseType);
      assert.deepStrictEqual(
        phases.filter((p) => p === 'research' || p === 'subagent' || p === 'lesson').filter((p, i, run) => i === 0 || run[i - 1] !== p),
        ['research', 'subagent', 'lesson'],
        `each call's phase, in the order of the calls: ${phases.join(', ')}`,
      );
      manager.close();
    });

    it('should force hierarchical mode', () => {
      const strategy = new KnowledgeStrategy({ hierarchical: false });
      const config = (strategy as any).config;
      assert.strictEqual(config.hierarchical, true, 'Should force hierarchical: true');
    });

    it('should have correct strategy name', () => {
      const strategy = new KnowledgeStrategy();
      assert.strictEqual(strategy.name, 'knowledge');
    });
  });

  describe('Integration with Compression', () => {
    it('should compress chunks with phase-aware prompts via mock membrane', async () => {
      cleanup();
      let lastRequest: any = null;

      const mockMembrane = {
        complete: async (request: any) => {
          lastRequest = request;
          return {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'Summary of the chunk' }],
          };
        },
      };

      const strategy = new KnowledgeStrategy({
        targetChunkTokens: 100,
        recentWindowTokens: 50,
        compressionModel: 'test-compression-model',
        l1HoldbackChunks: 0,
      });

      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
        membrane: mockMembrane as any,
      });
      manager.setToolDefinitions([
        { name: 'mcpl:search', description: 'search', inputSchema: { type: 'object' } },
        { name: 'mcpl:get', description: 'get', inputSchema: { type: 'object' } },
      ] as never);

      // Research messages
      manager.addMessage('Claude', [{
        type: 'tool_use', id: 'tu1', name: 'mcpl:search', input: {},
      }]);
      manager.addMessage('User', [{
        type: 'tool_result', toolUseId: 'tu1', content: 'Results ' + 'x'.repeat(200),
      }]);
      manager.addMessage('Claude', [{
        type: 'tool_use', id: 'tu2', name: 'mcpl:get', input: {},
      }]);
      manager.addMessage('User', [{
        type: 'tool_result', toolUseId: 'tu2', content: 'More results ' + 'x'.repeat(200),
      }]);

      // Push into compression zone
      for (let i = 0; i < 8; i++) {
        manager.addMessage('User', [{ type: 'text', text: `Pad ${i} ${'x'.repeat(50)}` }]);
      }

      // Trigger compression
      await manager.compile();
      if (!manager.isReady()) {
        await manager.tick();
      }

      assert.ok(lastRequest, 'premise: a compression request was sent');
      const lastMessage = lastRequest.messages[lastRequest.messages.length - 1];
      const text = lastMessage.content.map((b: any) => b.text).join('');
      assert.ok(text.includes('research'),
        'Compression prompt should mention research for research chunks');

      manager.close();
    });
  });
});

// Utility for tests that don't open a manager
function manager_close_noop() {
  // Tests that only use strategy methods directly don't need cleanup
}
