/**
 * Shared harness for driving a `ContextStrategy` through a synthetic
 * workload. Used by both the cache bench (which layers cache-prefix
 * analysis on top) and long-context invariant tests (which assert on
 * strategy state shape across many turns).
 *
 * Responsibilities:
 *  - Set up a temporary Chronicle, a `Membrane` wrapping a `MockAdapter`
 *    (with a `NativeFormatter` so each message is a separate, cacheable
 *    provider message), and a `ContextManager` bound to the given strategy.
 *  - Replay the workload turn-by-turn: add the message, drain queued
 *    compression via tick(), compile, run the request through Membrane,
 *    capture the raw provider request.
 *  - Discriminate compression calls from agent calls by a sentinel in the
 *    system prompt — compression calls are routed to the caller-supplied
 *    `compressor` and recorded for later inspection.
 *  - Snapshot the strategy's protected fields (`chunks`, `summaries`)
 *    after each turn so callers can compute invariants over time.
 *
 * What this harness deliberately does NOT do: it does not analyze the
 * captured requests. Cache-stat math lives in the bench driver; invariant
 * assertions live in test files. Keeping this layer mechanism-only means
 * one piece of scaffolding serves both consumers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Membrane,
  MockAdapter,
  NativeFormatter,
  type NormalizedRequest,
} from '@animalabs/membrane';
import { ContextManager } from '../../src/context-manager.js';
import type { ContextStrategy } from '../../src/types/index.js';

import type { WorkloadTurn } from './workload.js';

const AGENT_SENTINEL = '[[BENCH_AGENT_TURN]]';
export const AGENT_SYSTEM_PROMPT = `${AGENT_SENTINEL} You are a helpful assistant.`;

/**
 * Compression call captured by the harness. `inputMessages` is the raw
 * messages array the strategy passed to its summarizer — useful for
 * "what was being compressed?" diagnostics but note that messages do
 * not carry their store IDs at this layer (the strategy strips them
 * before composing the prompt), so cross-referencing back to source
 * IDs has to go through the strategy-state snapshot, not this field.
 */
export interface CompressionCallRecord {
  /** 1-indexed across the entire run. */
  callIndex: number;
  /** Turn during which this call fired. */
  turnIndex: number;
  /** Messages array the compressor received. Opaque; shape determined by strategy. */
  inputMessages: unknown[];
}

/** Minimal projection of a `Chunk` exposing only what consumers need. */
export interface ChunkSnapshot {
  messageIds: ReadonlyArray<string>;
  compressed: boolean;
  summaryId?: string;
}

/** Minimal projection of a `SummaryEntry` with the merge pointer normalized. */
export interface SummarySnapshot {
  id: string;
  level: number;
  sourceIds: ReadonlyArray<string>;
  sourceRange: { first: string; last: string };
  /** Either the new `parentId` or the legacy `mergedInto`. */
  parentId?: string;
}

export interface StrategySnapshot {
  /** All summaries — both active and merged-away. Use `parentId` to filter. */
  summaries: ReadonlyArray<SummarySnapshot>;
  chunks: ReadonlyArray<ChunkSnapshot>;
  compressionQueueLength: number;
}

export interface TurnRecord {
  turnIndex: number;
  /** Raw provider request as observed via onRequest, or null on compile failure. */
  rawRequest: unknown | null;
  /** Set when membrane.complete threw on compile — turn was best-effort fallback. */
  compileError?: string;
  /** Strategy state after the drain loop for this turn. */
  snapshot: StrategySnapshot;
  /** Compression calls that fired during this turn (1-indexed, monotonic across run). */
  compressionsThisTurn: CompressionCallRecord[];
}

export interface HarnessOptions {
  /**
   * Called when the strategy makes a compression call. Receives the
   * compressor's input messages and the global call index. Should return
   * the summary text. Length controls how big the resulting L1 is; content
   * controls cache-prefix divergence (only matters for cache-stat consumers).
   */
  compressor: (call: CompressionCallRecord) => string;
  agentSystemPrompt?: string;
  compileBudget?: { maxTokens: number; reserveForResponse: number };
  /** Tick-loop iterations per turn (drains queued compression). Default 10. */
  maxTicksPerTurn?: number;
  /** If set, prints one line per turn to stderr while running. */
  verbose?: boolean;
  /** Tag used in the verbose log prefix. */
  label?: string;
}

export interface HarnessResult {
  perTurn: TurnRecord[];
  /** Total compression calls across the run. */
  totalCompressions: number;
  /** Total turns where membrane.complete threw on compile output. */
  compileErrors: number;
}

interface StrategyInternals {
  chunks: ReadonlyArray<{
    messages: ReadonlyArray<{ id: string }>;
    compressed: boolean;
    summaryId?: string;
  }>;
  summaries: ReadonlyArray<{
    id: string;
    level: number;
    sourceIds: ReadonlyArray<string>;
    sourceRange: { first: string; last: string };
    parentId?: string;
    mergedInto?: string;
  }>;
  compressionQueue: ReadonlyArray<number>;
}

function stringifySystem(sys: unknown): string {
  if (!sys) return '';
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys
      .map((b) =>
        b && typeof b === 'object' && 'text' in b
          ? (b as { text: string }).text
          : '',
      )
      .join(' ');
  }
  return '';
}

function snapshotStrategy(strategy: ContextStrategy): StrategySnapshot {
  // Strategy internals are protected; tests and bench both reach in via
  // a structural cast. This mirrors the access pattern in
  // test/adaptive/harness.ts.
  const s = strategy as unknown as Partial<StrategyInternals>;
  const chunks: ChunkSnapshot[] = (s.chunks ?? []).map((c) => ({
    messageIds: c.messages.map((m) => m.id),
    compressed: c.compressed,
    summaryId: c.summaryId,
  }));
  const summaries: SummarySnapshot[] = (s.summaries ?? []).map((sm) => ({
    id: sm.id,
    level: sm.level,
    sourceIds: [...sm.sourceIds],
    sourceRange: { ...sm.sourceRange },
    parentId: sm.parentId ?? sm.mergedInto,
  }));
  return {
    chunks,
    summaries,
    compressionQueueLength: (s.compressionQueue ?? []).length,
  };
}

export async function runStrategyOnWorkload(
  strategyFactory: () => ContextStrategy,
  workload: WorkloadTurn[],
  opts: HarnessOptions,
): Promise<HarnessResult> {
  const label = opts.label ?? 'harness';
  const tmpRoot = mkdtempSync(
    join(tmpdir(), `cm-harness-${label.replace(/[^a-z0-9]/gi, '_')}-`),
  );
  const tmpPath = join(tmpRoot, 'store.chronicle');

  const compressionCalls: CompressionCallRecord[] = [];
  // Current turn index so the compressor callback (invoked synchronously
  // by MockAdapter inside membrane.complete) can stamp records correctly.
  // Kept as a closure variable updated each iteration.
  let currentTurn = -1;

  const adapter = new MockAdapter({
    responseGenerator: (req) => {
      const sysText = stringifySystem(
        (req as { system?: unknown }).system,
      );
      const isAgentTurn = sysText.includes(AGENT_SENTINEL);
      if (isAgentTurn) {
        return 'OK';
      }
      const messages =
        ((req as { messages?: unknown[] }).messages as unknown[]) ?? [];
      const record: CompressionCallRecord = {
        callIndex: compressionCalls.length + 1,
        turnIndex: currentTurn,
        inputMessages: messages,
      };
      compressionCalls.push(record);
      return opts.compressor(record);
    },
  });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });

  let cm: ContextManager | null = null;
  let compileErrors = 0;
  const strategy = strategyFactory();
  try {
    cm = await ContextManager.open({
      path: tmpPath,
      strategy,
      membrane,
    });
    // Compression defers indefinitely when history contains tool blocks
    // but no tool definitions are declared — declare the one synthetic
    // tool the workload generator emits, or nothing ever compresses.
    cm.setToolDefinitions([
      {
        name: 'fake_tool',
        description: 'synthetic workload tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);

    const perTurn: TurnRecord[] = [];
    const budget =
      opts.compileBudget ?? { maxTokens: 100_000, reserveForResponse: 2000 };
    const maxTicks = opts.maxTicksPerTurn ?? 10;
    const agentSystem = opts.agentSystemPrompt ?? AGENT_SYSTEM_PROMPT;

    for (let i = 0; i < workload.length; i++) {
      currentTurn = i;
      const turn = workload[i];
      cm.addMessage(turn.participant, turn.content);

      const compressionsBefore = compressionCalls.length;

      // Drain compression work so the next compile reflects post-tick state.
      for (let k = 0; k < maxTicks; k++) {
        if (cm.isReady()) break;
        await cm.tick();
      }
      // One extra tick: isReady() can flip true the moment the queue empties,
      // but a follow-up merge may still be queued. tick() is a no-op when
      // there's nothing to do.
      await cm.tick();

      let rawReq: unknown = null;
      let compileError: string | undefined;
      try {
        // The compile itself can throw (e.g. the adaptive path's
        // newest-turn-retained guard fires when the workload compiles
        // mid-tool-cycle and the trailing orphan tool_use gets trimmed).
        // Count it the same as a downstream composition failure: this
        // harness measures survival, it doesn't require every compile
        // point to be a valid inference point.
        const compiled = await cm.compile(budget);

        // Tag the last compiled message with a cache breakpoint — production
        // agent callers typically mark the last message so the entire prior
        // turn is reusable. Without it, cache analysis becomes meaningless.
        // Invariant tests don't read the cache flag but pay nothing for it.
        const taggedMessages = compiled.messages.map((m, idx) => {
          const isLast = idx === compiled.messages.length - 1;
          return isLast ? { ...m, cacheBreakpoint: true } : m;
        });

        const normalized: NormalizedRequest = {
          messages: taggedMessages,
          system: agentSystem,
          config: { model: 'claude-sonnet-4-5', maxTokens: 1000 },
        };

        try {
          await membrane.complete(normalized, {
            onRequest: (r) => {
              rawReq = r;
            },
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          compileError = errMsg;
          compileErrors++;
          // Best-effort fallback so consumers can still see the intent of
          // what would have been sent (cache stats treat it as all-fresh).
          rawReq = {
            system: agentSystem,
            messages: taggedMessages.map((m) => ({
              role:
                m.participant === 'Claude' || m.participant === 'assistant'
                  ? 'assistant'
                  : 'user',
              content: m.content,
            })),
          };
          if (opts.verbose) {
            process.stderr.write(
              `  [${label}] turn ${i + 1} compile error: ${errMsg.slice(0, 120)}\n`,
            );
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        compileError = errMsg;
        compileErrors++;
        if (opts.verbose) {
          process.stderr.write(
            `  [${label}] turn ${i + 1} compile threw: ${errMsg.slice(0, 120)}\n`,
          );
        }
      }

      const snapshot = snapshotStrategy(strategy);
      const compressionsThisTurn = compressionCalls.slice(compressionsBefore);

      perTurn.push({
        turnIndex: i,
        rawRequest: rawReq,
        compileError,
        snapshot,
        compressionsThisTurn,
      });

      if (opts.verbose) {
        const activeSummaries = snapshot.summaries.filter(
          (s) => !s.parentId,
        ).length;
        process.stderr.write(
          `  [${label}] turn ${i + 1}/${workload.length}: ` +
            `chunks=${snapshot.chunks.length}, ` +
            `summaries(active)=${activeSummaries}, ` +
            `compressions+${compressionsThisTurn.length} (total ${compressionCalls.length})\n`,
        );
      }
    }

    return {
      perTurn,
      totalCompressions: compressionCalls.length,
      compileErrors,
    };
  } finally {
    if (cm) {
      try {
        cm.close();
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
