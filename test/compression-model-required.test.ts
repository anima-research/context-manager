import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

const STORE_PATH = './test-compression-model-required';
const LOG_PATH = './test-compression-model-required.jsonl';
const UNWRITABLE_STORE = './test-compression-model-required-unwritable';
const UNWRITABLE_LOG = './test-compression-model-required-log-dir';

function cleanup(): void {
  for (const path of [STORE_PATH, LOG_PATH, UNWRITABLE_STORE, UNWRITABLE_LOG]) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
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
        namespace: 'agents/tern',
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
      errors.some((line) => line.includes('compressionModel is NOT configured') && line.endsWith(' ns=agents/tern')),
      'the halt must be visible on stderr, naming the namespace it halts (#239)',
    );

    const entries = readFileSync(LOG_PATH, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].event, 'no-compression-model');
    assert.strictEqual(entries[0].fatal, true);
    // One process's strategies share the log: each entry names its namespace (#239).
    assert.strictEqual(entries[0].namespace, 'agents/tern');
    assert.strictEqual(typeof entries[0].timestamp, 'number');
  });

  // #239: a log entry the log can't take is reported, naming the namespace whose entry it was.
  it('reports a compression log it cannot write, naming the namespace', async (t) => {
    const priorLogPath = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(String(args[0])); });
    t.mock.method(console, 'error', () => {});
    // A directory, so every append to it fails.
    mkdirSync(UNWRITABLE_LOG, { recursive: true });
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = UNWRITABLE_LOG;
    let manager: ContextManager | undefined;
    try {
      manager = await ContextManager.open({
        path: UNWRITABLE_STORE,
        strategy: new AutobiographicalStrategy({
          targetChunkTokens: 20,
          headWindowTokens: 0,
          recentWindowTokens: 0,
          hierarchical: true,
          l1HoldbackChunks: 0,
          minChunkCharsForLLM: 0,
          autoTickOnNewMessage: false,
        }),
        namespace: 'agents/tern',
        membrane: { complete: async () => ({ stopReason: 'end_turn', content: [] }) } as never,
      });
      for (let i = 0; i < 8; i++) {
        manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
          { type: 'text', text: `substantive event ${i} ` + 'word '.repeat(40) },
        ]);
      }
      await manager.compile();
      await assert.rejects(manager.tick(), /compressionModel is NOT configured/);
    } finally {
      await manager?.close();
      if (priorLogPath === undefined) {
        delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      } else {
        process.env.CONTEXT_MANAGER_COMPRESSION_LOG = priorLogPath;
      }
    }
    assert.ok(warnings.includes('compression log write failed: ns=agents/tern'), warnings.join('\n'));
  });
});
