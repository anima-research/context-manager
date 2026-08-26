/**
 * The mint telemetry receipt must name the prompt that was SENT.
 *
 * Both mint builders serve `ctx.systemPrompt` — a LIVE getter onto the last
 * value the host pushed — into the request's `system` field at assembly, and
 * both then log the call from a `finally` that runs after an awaited membrane
 * round trip. Re-reading the getter there reads whatever the host has pushed
 * SINCE dispatch, so a host activation landing while a mint is in flight
 * makes the receipt attribute the memory to a prompt that call never sent.
 * The audit log's whole job is "no reconstruction, no assumption about
 * whether the strategy code matches what produced historical summaries", so a
 * receipt that can silently misname its own input is worse than no field.
 *
 * The fix logs the captured request's own `system` field. This test pins it
 * by making the race deterministic: the harness membrane refreshes the host
 * prompt from inside `complete()`, i.e. strictly between dispatch and
 * resolution, on every call. Each refresh has a distinct length, so the
 * logged `textChars` identifies exactly which value was reported.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const ZZ_STORE_PATH = './test-zz-mint-telemetry-race';
const ZZ_LOG_PATH = './test-zz-mint-telemetry-race/zz-compression-log.jsonl';
const ZZ_COMPRESSION_MODEL = 'zz-mint-telemetry-model';

/** The prompt every mint in this workload is DISPATCHED with, initially. */
const ZZ_SYSTEM_PROMPT =
  'You are zz-archivist, a fictional agent whose whole conduct lives in ' +
  'system voice. Speak plainly and never invent a zz-quorum.';

/**
 * What the host "pushes" mid-flight. Distinct length per call, and never the
 * length of ZZ_SYSTEM_PROMPT, so a logged textChars pins down which value the
 * receipt read rather than merely whether one was present.
 */
function zzRefreshedPrompt(callIndex: number): string {
  return `${ZZ_SYSTEM_PROMPT} zz-refresh-${callIndex}${'.'.repeat(callIndex)}`;
}

interface CompressionLogEntry {
  event?: string;
  operation?: string;
  system?: { present: boolean; textChars: number } | null;
  metadata?: { stub?: boolean };
}

function cleanup(): void {
  if (existsSync(ZZ_STORE_PATH)) {
    rmSync(ZZ_STORE_PATH, { recursive: true, force: true });
  }
}

const t = (text: string): ContentBlock => ({ type: 'text', text });

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

/**
 * Mint calls in dispatch order, each paired with the prompt that was actually
 * on the wire and the prompt the live getter held once the call resolved.
 */
interface DispatchRecord {
  dispatchedSystem: string | undefined;
  systemAtResolution: string;
}

async function runRefreshingWorkload(): Promise<DispatchRecord[]> {
  cleanup();
  const dispatches: DispatchRecord[] = [];
  let manager: ContextManager | undefined;

  const membrane = {
    complete: async (request: NormalizedRequest) => {
      const callIndex = dispatches.length;
      // The refresh lands strictly between dispatch and resolution: the
      // request bytes are already fixed, the awaiting `finally` has not run.
      const refreshed = zzRefreshedPrompt(callIndex);
      manager!.setSystemPrompt(refreshed);
      dispatches.push({
        dispatchedSystem: request.system,
        systemAtResolution: refreshed,
      });
      const summary =
        'A stretch of routine traffic worth remembering in some detail: ' +
        'word '.repeat(40);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: summary }],
        usage: { input_tokens: 1000, output_tokens: 50 },
      };
    },
  };

  const strategy = new AutobiographicalStrategy({
    compressionModel: ZZ_COMPRESSION_MODEL,
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    mergeThreshold: 2,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);

  manager = await ContextManager.open({
    path: ZZ_STORE_PATH,
    strategy,
    membrane: membrane as any,
  });
  manager.setSystemPrompt(ZZ_SYSTEM_PROMPT);

  for (let i = 0; i < 60; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
      t(`turn ${i} of steady substantive traffic about the ongoing work `.repeat(3)),
    ]);
    await drain(manager);
  }
  await manager.close();
  return dispatches;
}

/** The per-call summary receipts, in resolution order (which is dispatch order). */
function readMintReceipts(): CompressionLogEntry[] {
  const raw = readFileSync(ZZ_LOG_PATH, 'utf8').trim();
  const entries = raw.split('\n').map((line) => JSON.parse(line) as CompressionLogEntry);
  return entries.filter(
    (entry) =>
      // Event-tagged rows are attempt/curve/fallback receipts, not the
      // per-call summary; the `stub` row is the no-LLM-call quiet-stretch
      // path, which dispatches nothing and correctly logs system: null.
      !entry.event &&
      !entry.metadata?.stub &&
      (entry.operation === 'compress_l1' || String(entry.operation).startsWith('merge_l')),
  );
}

describe('Mint telemetry: the logged system prompt is the dispatched one', () => {
  before(cleanup);
  after(cleanup);

  it('reports the DISPATCHED prompt when the host refreshes mid-flight', async () => {
    const priorLogPath = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = ZZ_LOG_PATH;

    let dispatches: DispatchRecord[];
    try {
      dispatches = await runRefreshingWorkload();
    } finally {
      if (priorLogPath === undefined) {
        delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      } else {
        process.env.CONTEXT_MANAGER_COMPRESSION_LOG = priorLogPath;
      }
    }

    const receipts = readMintReceipts();

    // Guard the guard: a workload that never raced, or never merged, would
    // let a getter-reading receipt pass vacuously.
    assert.ok(dispatches.length >= 2, `expected mint calls, got ${dispatches.length}`);
    assert.ok(
      receipts.some((entry) => entry.operation === 'compress_l1'),
      'expected L1 mint receipts',
    );
    assert.ok(
      receipts.some((entry) => String(entry.operation).startsWith('merge_l')),
      'expected merge mint receipts — both builders carry this telemetry',
    );
    assert.ok(
      dispatches.some((d) => d.dispatchedSystem !== d.systemAtResolution),
      'the harness must actually change the prompt between dispatch and resolution',
    );
    assert.strictEqual(
      receipts.length,
      dispatches.length,
      'one summary receipt per mint call',
    );

    for (const [index, dispatch] of dispatches.entries()) {
      const receipt = receipts[index]!;
      const dispatched = dispatch.dispatchedSystem;
      assert.ok(dispatched, `call ${index} should have dispatched a system prompt`);
      assert.notStrictEqual(
        dispatched.length,
        dispatch.systemAtResolution.length,
        `call ${index}: dispatched and post-await lengths must differ for this to bite`,
      );
      assert.deepStrictEqual(
        receipt.system,
        { present: true, textChars: dispatched.length },
        `call ${index} (${receipt.operation}) must report the ${dispatched.length}-char ` +
          `prompt it SENT, not the ${dispatch.systemAtResolution.length}-char one the ` +
          'host pushed while the call was in flight',
      );
    }
  });
});
