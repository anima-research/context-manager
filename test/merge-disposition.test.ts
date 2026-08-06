/**
 * Terminal-disposition gate on L_n merges (2026-08-01).
 *
 * `executeMerge` used to persist ANY nonempty response text as the merged
 * parent — which is exactly how a 163-character cyber-refusal became an L4
 * parent over six real L3 children. The invariant under test:
 *
 *   A summary may become canonical only after a COMPLETE accepted terminal
 *   disposition: `end_turn` + nonempty text. Refusal, max_tokens truncation,
 *   tool_use, abort, empty, and malformed responses are never persisted;
 *   children stay unmerged; a durable receipt is recorded; retries are
 *   bounded (persisted attempt counter → durable merge quarantine), never
 *   an immediate loop. Accepted summaries persist their provenance
 *   (stopReason + requestHash + model) for post-hoc audit.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

const BASE = './test-merge-disposition';
const MODEL = 'same-model';
let sequence = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${BASE}-${sequence++}`;
  paths.push(path);
  return path;
}

function cleanup(): void {
  for (const path of paths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

type Handler =
  | { stop: 'refusal' | 'end_turn' | 'max_tokens'; text?: string }
  | { raw: unknown }
  | { error: Error };

function scripted(handlers: Handler[]) {
  const calls: unknown[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: unknown) => {
        const handler = handlers[calls.length] ?? handlers[handlers.length - 1]!;
        calls.push(structuredClone(request));
        if ('error' in handler) throw handler.error;
        if ('raw' in handler) return handler.raw;
        return {
          stopReason: handler.stop,
          content: handler.text ? [{ type: 'text', text: handler.text }] : [],
          usage: { inputTokens: 100, outputTokens: handler.text ? 20 : 0 },
        };
      },
    } as never,
  };
}

class Probe extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }

  qMerge(level: number, sourceIds: string[]): void {
    this.enqueueMerge({ level, sourceIds });
  }

  mergeQueueView(): Array<{ level: number; sourceIds: string[]; attempts?: number }> {
    return this.mergeQueue.map((item) => ({ ...item, sourceIds: [...item.sourceIds] }));
  }

  summariesView(): SummaryEntry[] {
    return [...this.summaries];
  }

  sweepMergeQuarantineForTest(): void {
    this.sweepPaidOffMergeQuarantine();
  }
}

function ctx(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

const t = (s: string): ContentBlock => ({ type: 'text', text: s });

interface Fixture {
  manager: ContextManager;
  strategy: Probe;
  sourceIds: string[];
}

/**
 * Real store + real messages + two seeded L1s over them, with a level-2
 * merge already queued. `tick()` drives the REAL executeMerge.
 */
async function fixture(
  membrane: unknown,
  options: ConstructorParameters<typeof Probe>[0] = {},
  path = freshPath(),
  seedAndQueue = true,
): Promise<Fixture> {
  const strategy = new Probe({
    compressionModel: MODEL,
    hierarchical: true,
    targetChunkTokens: 100_000, // chunks never close — merge path only
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    mergeThreshold: 99,
    quarantineAlarmIntervalMs: 0,
    ...options,
  });
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`raw-${i} ` + 'substance '.repeat(10))]));
  }
  const l1 = (id: string, a: number, b: number): SummaryEntry => ({
    id,
    level: 1,
    content: `authored ${id}`,
    tokens: 20,
    sourceLevel: 0,
    sourceIds: [ids[a]!, ids[b]!],
    sourceRange: { first: ids[a]!, last: ids[b]! },
    created: 1,
  });
  const sourceIds = ['L1-100', 'L1-101'];
  if (seedAndQueue) {
    strategy.seed(l1('L1-100', 0, 1));
    strategy.seed(l1('L1-101', 2, 3));
    strategy.qMerge(2, sourceIds);
  }
  return { manager, strategy, sourceIds };
}

function storedMergeQueue(manager: ContextManager): Array<{ attempts?: number }> {
  const value = manager.getStore().getStateJson('default/autobio:mergeQueue');
  return Array.isArray(value) ? (value as Array<{ attempts?: number }>) : [];
}

function storedMergeQuarantine(manager: ContextManager): Array<Record<string, unknown>> {
  const value = manager.getStore().getStateJson('default/autobio:merge-quarantine');
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

describe('Merge terminal-disposition gate', () => {
  after(cleanup);

  it('a refusal with plausible text is NEVER persisted as the parent (the L4 incident shape)', async () => {
    const refusalText = 'I cannot help with analyzing this content as it relates to cyber operations.';
    const mock = scripted([
      { stop: 'refusal', text: refusalText },
      { stop: 'refusal', text: refusalText },
      { stop: 'end_turn', text: 'A real consolidation of the two memories.' },
    ]);
    const fx = await fixture(mock.membrane, { mergeAttemptLimit: 5 });

    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(mock.calls.length, 1);
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 0,
      'refusal text must not become a parent');
    assert.ok(fx.strategy.summariesView().every((s) => s.level !== 1 || !s.mergedInto),
      'children stay unmerged');
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1, 'attempt accounted');
    assert.equal(storedMergeQueue(fx.manager)[0]?.attempts, 1, 'attempt counter is persisted');

    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 2);

    // Third attempt succeeds with a complete end_turn — merge persists WITH provenance.
    await fx.strategy.tick(ctx(fx.manager));
    const parent = fx.strategy.summariesView().find((s) => s.level === 2);
    assert.ok(parent, 'end_turn merge persists');
    assert.equal(parent!.content, 'A real consolidation of the two memories.');
    assert.equal(parent!.provenance?.stopReason, 'end_turn');
    assert.match(String(parent!.provenance?.requestHash), /^[a-f0-9]{64}$/);
    assert.equal(parent!.provenance?.model, MODEL);
    for (const id of fx.sourceIds) {
      const child = fx.strategy.summariesView().find((s) => s.id === id)!;
      assert.equal(child.mergedInto, parent!.id, 'children marked only after acceptance');
    }
    assert.equal(fx.strategy.mergeQueueView().length, 0);
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0);

    // Provenance round-trips through the chronicle.
    await fx.manager.close();
    const reopened = await fixture(mock.membrane, { mergeAttemptLimit: 5 }, paths[paths.length - 1]!, false);
    const reloaded = reopened.strategy.summariesView().find((s) => s.level === 2);
    assert.equal(reloaded?.provenance?.stopReason, 'end_turn');
    assert.equal(reloaded?.provenance?.requestHash, parent!.provenance?.requestHash);
    await reopened.manager.close();
  });

  it('max_tokens truncation and tool_use preambles are rejected, not canonized', async () => {
    const shapes: Handler[] = [
      { stop: 'max_tokens', text: 'a rich but truncated consolidation cut off mid-' },
      {
        raw: {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me look that up first.' },
            { type: 'tool_use', id: 'tu-1', name: 'search', input: { q: 'x' } },
          ],
        },
      },
    ];
    for (const shape of shapes) {
      const mock = scripted([shape]);
      const fx = await fixture(mock.membrane);
      await fx.strategy.tick(ctx(fx.manager));
      assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 0);
      assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1, 'bounded retry, entry retained');
      await fx.manager.close();
    }
  });

  it('empty end_turn output is bounded-retried, not silently dropped from the queue', async () => {
    const mock = scripted([{ stop: 'end_turn', text: '' }]);
    const fx = await fixture(mock.membrane);
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 0);
    assert.equal(fx.strategy.mergeQueueView().length, 1, 'entry retained for bounded retry');
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1);
    await fx.manager.close();
  });

  it('exhausted attempts move the merge into durable quarantine; re-enqueue is blocked until cleared', async () => {
    const path = freshPath();
    const mock = scripted([
      { stop: 'refusal', text: 'refusal text one' },
      { stop: 'refusal', text: 'refusal text two' },
      { stop: 'end_turn', text: 'Post-clear consolidation.' },
    ]);
    const fx = await fixture(mock.membrane, { mergeAttemptLimit: 2 }, path);

    await fx.strategy.tick(ctx(fx.manager));
    await fx.strategy.tick(ctx(fx.manager));

    assert.equal(fx.strategy.mergeQueueView().length, 0, 'exhausted merge dequeued');
    const status = fx.strategy.getMergeQuarantineStatus();
    assert.equal(status.count, 1);
    assert.equal(status.records[0]!.level, 2);
    assert.deepEqual(status.records[0]!.sourceIds, fx.sourceIds);
    assert.equal(status.records[0]!.attempts, 2);
    assert.equal(status.records[0]!.lastOutcome, 'refusal');
    assert.match(String(status.records[0]!.lastRequestHash), /^[a-f0-9]{64}$/);
    assert.equal(storedMergeQuarantine(fx.manager).length, 1, 'quarantine record is durable');

    // Re-enqueue of the same source set is refused while quarantined.
    fx.strategy.qMerge(2, fx.sourceIds);
    assert.equal(fx.strategy.mergeQueueView().length, 0, 'quarantined source set cannot re-enqueue');

    // Quarantine survives restart.
    await fx.manager.close();
    const re = await fixture(mock.membrane, { mergeAttemptLimit: 2 }, path, false);
    assert.equal(re.strategy.getMergeQuarantineStatus().count, 1, 'quarantine survives reopen');
    re.strategy.qMerge(2, fx.sourceIds);
    assert.equal(re.strategy.mergeQueueView().length, 0);

    // Operator clears → retry becomes possible → end_turn response persists.
    re.strategy.clearMergeQuarantine();
    assert.equal(re.strategy.getMergeQuarantineStatus().count, 0);
    assert.equal(storedMergeQuarantine(re.manager).length, 0, 'clear is durable');
    re.strategy.qMerge(2, fx.sourceIds);
    assert.equal(re.strategy.mergeQueueView().length, 1);
    await re.strategy.tick(ctx(re.manager));
    const parent = re.strategy.summariesView().find((s) => s.level === 2);
    assert.equal(parent?.content, 'Post-clear consolidation.');
    assert.equal(parent?.provenance?.stopReason, 'end_turn');
    await re.manager.close();
  });

  it('transient transport errors keep pre-existing semantics: rethrown, no attempt accounting', async () => {
    const mock = scripted([{ error: new Error('synthetic 429') }]);
    const fx = await fixture(mock.membrane);
    await assert.rejects(fx.strategy.tick(ctx(fx.manager)), /synthetic 429/);
    assert.equal(fx.strategy.mergeQueueView().length, 1, 'entry stays queued');
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, undefined, 'no bounded-retry accounting');
    await fx.manager.close();
  });

  it('tool_use rejection appends the no-tools line on the retry — and only on the retry', async () => {
    // The lena 2026-08-04 wedge: a summarizer whose recent spans are
    // tool-heavy answers the merge prompt with a `think` call carrying the
    // draft; the single-shot compression path dies at the tool boundary on
    // every identical retry. The retry must differ by exactly one sentence.
    const NO_TOOLS_LINE = 'do not call any tools for this';
    const mock = scripted([
      {
        raw: {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'think', input: { content: 'draft…' } }],
        },
      },
      { stop: 'end_turn', text: 'the merged memory body, written as prose' },
    ]);
    const fx = await fixture(mock.membrane);

    await fx.strategy.tick(ctx(fx.manager)); // attempt 1: rejected
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1);
    const instructionOf = (call: unknown): string => {
      const messages = (call as { messages: Array<{ content: Array<{ text?: string }> }> }).messages;
      return messages[messages.length - 1]!.content.map((b) => b.text ?? '').join('\n');
    };
    assert.ok(
      !instructionOf(mock.calls[0]).includes(NO_TOOLS_LINE),
      'first attempt must be byte-identical to the standard prompt',
    );

    await fx.strategy.tick(ctx(fx.manager)); // attempt 2: retry with the line
    assert.ok(
      instructionOf(mock.calls[1]).includes(NO_TOOLS_LINE),
      'retry after tool_use must carry the no-tools instruction',
    );
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 1, 'merge canonized');
    assert.equal(fx.strategy.mergeQueueView().length, 0, 'queue drained');
    await fx.manager.close();
  });

  it('refusal rejection switches the retry to the source-level fallback payload', async () => {
    // The labclaude 2026-08-06 wedge: an L2 merge whose one-level-deeper raw
    // replay carries enough diffuse classifier-trigger mass is refused on
    // INPUT, deterministically, on every identical retry (5/5, then
    // quarantine, pyramid frozen). The retry must swap the TARGET expansion
    // for the sources themselves as recall pairs; the first attempt stays
    // byte-identical to the standard prompt.
    const mock = scripted([
      { stop: 'refusal' },
      { stop: 'end_turn', text: 'the merged memory body, written as prose' },
    ]);
    const fx = await fixture(mock.membrane);

    const flat = (call: unknown): string =>
      JSON.stringify((call as { messages: unknown }).messages);

    await fx.strategy.tick(ctx(fx.manager)); // attempt 1: refused
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1);
    assert.ok(flat(mock.calls[0]).includes('raw-0'), 'first attempt replays the raw span');
    assert.ok(
      !flat(mock.calls[0]).includes('authored L1-100'),
      'first attempt does not show the source summaries',
    );

    await fx.strategy.tick(ctx(fx.manager)); // attempt 2: source-level fallback
    const second = flat(mock.calls[1]);
    assert.ok(
      second.includes('authored L1-100') && second.includes('authored L1-101'),
      'retry shows the sources themselves as recall pairs',
    );
    assert.ok(!second.includes('raw-0'), 'retry does not replay the raw span');
    assert.ok(
      second.includes('the L1 memories above'),
      'retry instruction describes summary-level content, not raw conversation',
    );
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 1, 'merge canonized');
    assert.equal(fx.strategy.mergeQueueView().length, 0, 'queue drained');
    await fx.manager.close();
  });

  it('refusal fallback is sticky and composes with the no-tools retry line', async () => {
    // refusal → tool_use → third attempt: hadRefusal keeps the source-level
    // payload (no raw→fallback oscillation) AND lastStopReason=tool_use adds
    // the no-tools sentence. Both retry remedies apply at once.
    const NO_TOOLS_LINE = 'do not call any tools for this';
    const mock = scripted([
      { stop: 'refusal' },
      {
        raw: {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'think', input: { content: 'draft…' } }],
        },
      },
      { stop: 'end_turn', text: 'the merged memory body, written as prose' },
    ]);
    const fx = await fixture(mock.membrane);

    const flat = (call: unknown): string =>
      JSON.stringify((call as { messages: unknown }).messages);

    await fx.strategy.tick(ctx(fx.manager)); // refused
    await fx.strategy.tick(ctx(fx.manager)); // fallback payload, dies on tool_use
    await fx.strategy.tick(ctx(fx.manager)); // fallback payload + no-tools line
    const third = flat(mock.calls[2]);
    assert.ok(
      third.includes('authored L1-100') && !third.includes('raw-0'),
      'third attempt keeps the source-level fallback payload',
    );
    assert.ok(third.includes(NO_TOOLS_LINE), 'third attempt carries the no-tools instruction');
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 1, 'merge canonized');
    assert.equal(fx.strategy.mergeQueueView().length, 0, 'queue drained');
    await fx.manager.close();
  });

  it('a thinking-wrapped merge generation is rejected and the retry carries the plain-prose line', async () => {
    // Opus-3-class summarizers wrap the entire memory in a literal
    // <thinking> tag (evander 2026-08-06). The text passes the disposition
    // gate (nonempty) but strips to empty — previously a SILENT skip that
    // retried the identical prompt forever. It must be a counted rejection,
    // and the retry must ask for plain prose.
    const PROSE_MARK = 'do not wrap it in <thinking>';
    const mock = scripted([
      { stop: 'end_turn', text: '<thinking>\nthe whole memory, wrapped\n</thinking>' },
      { stop: 'end_turn', text: 'the merged memory body, written as prose' },
    ]);
    const fx = await fixture(mock.membrane);

    const instructionOf = (call: unknown): string => {
      const messages = (call as { messages: Array<{ content: Array<{ text?: string }> }> }).messages;
      return messages[messages.length - 1]!.content.map((b) => b.text ?? '').join('\n');
    };

    await fx.strategy.tick(ctx(fx.manager)); // attempt 1: wrapped → rejected
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1, 'empty generation counted as an attempt');
    assert.ok(!instructionOf(mock.calls[0]).includes(PROSE_MARK), 'first attempt byte-canonical');

    await fx.strategy.tick(ctx(fx.manager)); // attempt 2: prose line, canonizes
    assert.ok(instructionOf(mock.calls[1]).includes(PROSE_MARK), 'retry carries the plain-prose instruction');
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 1, 'merge canonized');
    assert.equal(fx.strategy.mergeQueueView().length, 0, 'queue drained');
    await fx.manager.close();
  });

  it('quarantine debt is swept once the sources are covered by a parent', async () => {
    const mock = scripted([{ stop: 'refusal', text: 'nope' }]);
    const fx = await fixture(mock.membrane, { mergeAttemptLimit: 1 });
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 1);

    // Simulate coverage arriving another way (repair / operator merge).
    const children = fx.strategy.summariesView().filter((s) => s.level === 1);
    fx.strategy.seed({
      id: 'L2-900',
      level: 2,
      content: 'repair-authored parent',
      tokens: 20,
      sourceLevel: 1,
      sourceIds: children.map((s) => s.id),
      sourceRange: { first: children[0]!.sourceRange.first, last: children[1]!.sourceRange.last },
      created: 2,
    });
    for (const child of children) {
      (fx.strategy as unknown as { setMergedInto(s: SummaryEntry, id: string): void })
        .setMergedInto(child, 'L2-900');
    }
    fx.strategy.sweepMergeQuarantineForTest();
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0, 'paid-off record swept');
    assert.equal(storedMergeQuarantine(fx.manager).length, 0);
    await fx.manager.close();
  });
});
