import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

const STORE_PATH = './test-compression-model-required';
const LOG_PATH = './test-compression-model-required.jsonl';

function cleanup(): void {
  if (existsSync(STORE_PATH)) rmSync(STORE_PATH, { recursive: true, force: true });
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH, { force: true });
}

describe('AutobiographicalStrategy compression model contract', () => {
  before(cleanup);
  after(cleanup);

  it('halts memory formation loudly and writes a fatal audit event when no model is configured', async () => {
    const priorLogPath = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    const priorConsoleError = console.error;
    const errors: string[] = [];
    let membraneCalls = 0;
    let manager: ContextManager | undefined;

    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = LOG_PATH;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));

    try {
      const strategy = new AutobiographicalStrategy({
        targetChunkTokens: 20,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        hierarchical: true,
        l1HoldbackChunks: 0,
        minChunkCharsForLLM: 0,
        autoTickOnNewMessage: false,
      });
      manager = await ContextManager.open({
        path: STORE_PATH,
        strategy,
        membrane: {
          complete: async () => {
            membraneCalls++;
            return { stopReason: 'end_turn', content: [{ type: 'text', text: 'must not be written' }] };
          },
        } as never,
      });

      for (let i = 0; i < 8; i++) {
        manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
          { type: 'text', text: `substantive event ${i} ` + 'word '.repeat(40) },
        ]);
      }
      await manager.compile();

      await assert.rejects(
        manager.tick(),
        /compressionModel is NOT configured.*Memory formation is halted/,
      );
    } finally {
      await manager?.close();
      console.error = priorConsoleError;
      if (priorLogPath === undefined) {
        delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      } else {
        process.env.CONTEXT_MANAGER_COMPRESSION_LOG = priorLogPath;
      }
    }

    assert.strictEqual(membraneCalls, 0, 'an unspecified model must never reach the membrane');
    assert.ok(
      errors.some((line) => line.includes('compressionModel is NOT configured')),
      'the halt must be visible on stderr',
    );

    const entries = readFileSync(LOG_PATH, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].event, 'no-compression-model');
    assert.strictEqual(entries[0].fatal, true);
    assert.strictEqual(typeof entries[0].timestamp, 'number');
  });
});
