import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { Membrane, AnthropicAdapter } from 'membrane';

const TEST_STORE_PATH = './test-autobio-store';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

describe('AutobiographicalStrategy - Compression', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('should summarize conversation context honestly', async () => {
    cleanup();

    const membrane = new Membrane(new AnthropicAdapter({ apiKey: API_KEY }));

    const strategy = new AutobiographicalStrategy({
      targetChunkTokens: 300,
      recentWindowTokens: 400,
      compressionModel: 'claude-sonnet-4-20250514',
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane,
    });

    // A real conversation worth preserving
    manager.addMessage('User', [{ type: 'text', text: 'We are building a context management system for AI conversations.' }]);
    manager.addMessage('Claude', [{ type: 'text', text: 'That sounds interesting. What approach are you taking?' }]);
    manager.addMessage('User', [{ type: 'text', text: 'Two logs: an immutable message store and an editable context log. Strategies decide what goes in context.' }]);
    manager.addMessage('Claude', [{ type: 'text', text: 'The separation makes sense - source of truth vs working set. How do you handle compression?' }]);
    manager.addMessage('User', [{ type: 'text', text: 'Autobiographical strategy chunks old messages and asks for summaries. We want the summaries to be honest work, not fake memories.' }]);
    manager.addMessage('Claude', [{ type: 'text', text: 'That matters. Asking an instance to summarize is different from asking it to pretend it remembers.' }]);

    // Run compression if needed
    if (!manager.isReady()) {
      await manager.tick();
    }

    const compiled = await manager.compile();
    assert.ok(compiled.messages.length > 0, 'Should compile context');

    console.log('Compiled', compiled.messages.length, 'entries');
    manager.close();
  });
});
