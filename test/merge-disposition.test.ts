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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  rawText = (i: number) => `raw-${i} ` + 'substance '.repeat(10),
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
    ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [t(rawText(i))]));
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

/** A queued merge's run of failures, which the lane keeps in memory by the merge's identity. */
function mergeRun(strategy: unknown, merge: { level: number; sourceIds: readonly string[] } | undefined): { failures: number } | undefined {
  if (!merge) return undefined;
  return (strategy as { mergeFailureRuns: Map<string, { failures: number }> }).mergeFailureRuns
    .get(`${merge.level}\u0000${merge.sourceIds.join('\u0000')}`);
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

  it('a merge retried after tool_use is prepared again from its sources, and logged again', async () => {
    // An L1 attempt's retries are made from its sent request and log
    // nothing again; a merge's retry is built from its sources on a later
    // tick, so what preparation replaced in it is logged again (R2-5).
    const payload = 'P'.repeat(20000);
    const mock = scripted([
      {
        raw: {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'think', input: { content: 'draft…' } }],
        },
      },
      { stop: 'end_turn', text: 'the merged memory body, written as prose' },
    ]);
    const fx = await fixture(mock.membrane, {}, freshPath(), true,
      (i) => i === 0 ? `raw-0 data:image/png;base64,${payload}` : `raw-${i} ` + 'substance '.repeat(10));
    const logs: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
    try {
      await fx.strategy.tick(ctx(fx.manager)); // attempt 1: rejected on tool_use
      await fx.strategy.tick(ctx(fx.manager)); // attempt 2: built again
    } finally { console.error = original; }
    assert.equal(mock.calls.length, 2);
    for (const call of mock.calls) {
      const flat = JSON.stringify(call);
      assert.ok(flat.includes('raw-0') && !flat.includes(payload), 'each attempt replays the span with the marker');
    }
    const lines = logs.filter((line) => line.includes('serialized data URL(s) with markers'));
    assert.deepEqual(lines.map((line) => line.slice(line.lastIndexOf('['))), ['[merge-l2] ns=default', '[merge-l2] ns=default']);
    assert.equal(fx.strategy.summariesView().filter((s) => s.level === 2).length, 1, 'merge canonized');
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

  it('a merge that keeps failing while other work lands is bounded; one that fails in an outage is not (the rhys 500-loop)', async () => {
    // rhys 2026-08-06: 514 consecutive merge 500s across a week-long
    // provider episode, zero accounting. A failure that is not a rejection is
    // evidence about the merge only while other compression lands between its
    // failures on its route and model: an
    // outage, in which nothing lands, never counts; a merge that keeps failing
    // while other work lands routes, at the bound, into the normal bounded
    // rejection policy.
    const serverErr = Object.assign(new Error('500 {"type":"api_error"}'), {
      type: 'server', retryable: true, httpStatus: 500,
    });
    const mock = scripted([{ error: serverErr }]);
    const fx = await fixture(mock.membrane);
    const BOUND = (AutobiographicalStrategy as unknown as { COMPRESSION_PERSISTENT_FAILURES: number })
      .COMPRESSION_PERSISTENT_FAILURES;
    // Each failure also pauses the compression lane: a tick during the pause
    // makes no call. Expire it between ticks to stand for the time passing.
    const lane = fx.strategy as unknown as {
      compressionPause: { backoffUntil: number; statedUntil: number | null } | null;
      noteCompressionLanded(membrane: unknown, model: string): void;
    };
    const land = () => lane.noteCompressionLanded(ctx(fx.manager).membrane, MODEL);
    const expire = () => { lane.compressionPause!.backoffUntil = 0; lane.compressionPause!.statedUntil = null; };
    const streak = () => mergeRun(fx.strategy, fx.strategy.mergeQueueView()[0]);
    // An outage: nothing lands, so twelve failures count as one.
    for (let i = 0; i < 12; i++) {
      await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /500/, `tick ${i} rethrows`);
      expire();
    }
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts ?? 0, 0, 'no attempt burned in an outage');
    assert.equal(streak()?.failures, 1);
    // Other work lands before each of the next failures: each counts.
    for (let i = 2; i < BOUND; i++) {
      land();
      await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /500/);
      const calls = mock.calls.length;
      await fx.strategy.tick(ctx(fx.manager));
      assert.equal(mock.calls.length, calls, 'no call while the lane is paused');
      expire();
      assert.equal(fx.strategy.mergeQueueView()[0]?.attempts ?? 0, 0, 'no attempt burned below the bound');
    }
    assert.equal(streak()?.failures, BOUND - 1);
    land();
    await fx.strategy.tick(ctx(fx.manager)); // the bound: recorded, not thrown
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1, 'bounded policy engaged at the bound');
    // As in L1, the run is decided before any pause: the deciding failure is
    // the merge's own, so it pauses nothing, and the bounded policy's smaller
    // retry is asked at the next tick.
    assert.equal(streak(), undefined, 'the decided run is gone with its accounting');
    const calls = mock.calls.length;
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /500/);
    assert.equal(mock.calls.length, calls + 1, 'and installs no pause: the retry is called at once');
    await fx.manager.close();
  });

  it('a merge entry skipped with no call is neither an answer nor a landing', async () => {
    // executeMerge skips a stale entry (a source already parented) without a
    // call, writing nothing, and tick drops it from the queue. A skip says
    // nothing about the provider: it must not be a landing (in an outage,
    // each stale entry would let a failing request's next failure count) or
    // end the pause (the next failure would back off from 5 s again instead
    // of doubling from the genuine count).
    const network = Object.assign(new Error('zz network down'), { type: 'network', retryable: true });
    const mock = scripted([{ error: network }]);
    const fx = await fixture(mock.membrane);
    const lane = fx.strategy as unknown as {
      compressionPause: { backoffUntil: number; failures: number } | null;
      noteCompressionLanded(membrane: unknown, model: string): void;
    };
    lane.noteCompressionLanded(ctx(fx.manager).membrane, MODEL); // other work landed once
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(lane.compressionPause?.failures, 1);
    lane.compressionPause!.backoffUntil = 0; // the backoff has passed
    // Meanwhile another merge parented L1-100: the queued entry is stale.
    fx.strategy.summariesView().find((s) => s.id === 'L1-100')!.mergedInto = 'L2-900';
    // Count the landings from here on.
    let landings = 0;
    const landed = lane.noteCompressionLanded.bind(fx.strategy);
    lane.noteCompressionLanded = (membrane, model) => { landings++; landed(membrane, model); };
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(mock.calls.length, 1, 'skipped: no call');
    assert.equal(fx.strategy.mergeQueueView().length, 0, 'the stale entry is dropped');
    assert.equal(landings, 0, 'no landing');
    assert.equal(lane.compressionPause?.failures, 1, 'and no answer: the pause and its failure count stand');
    await fx.manager.close();
  });

  it('a non-retryable failure that says nothing about the request (credentials) pauses the lane, spending no merge attempt', async () => {
    // Only a request-attributable rejection is evidence about the merge
    // request. An expired key fails every request identically
    // until fixed: it pauses the lane instead of walking the bounded policy
    // toward quarantine.
    const authErr = Object.assign(new Error('401 invalid x-api-key'), { type: 'auth', retryable: false });
    const mock = scripted([{ error: authErr }]);
    const fx = await fixture(mock.membrane);
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /401/);
    assert.equal(fx.strategy.mergeQueueView().length, 1, 'the merge is still queued');
    assert.deepEqual(fx.strategy.mergeQueueView()[0]!.sourceIds, fx.sourceIds);
    assert.equal(fx.strategy.mergeQueueView()[0]!.attempts ?? 0, 0, 'no merge attempt spent');
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(mock.calls.length, 1, 'paused: no second call');
    assert.equal(fx.strategy.mergeQueueView().length, 1, 'and still queued for when the pause ends');
    await fx.manager.close();
  });

  it('any provider answer resets the pause, a refusal included', async () => {
    const network = Object.assign(new Error('zz network down'), { type: 'network', retryable: true });
    const mock = scripted([{ error: network }, { stop: 'refusal' }, { error: network }]);
    const fx = await fixture(mock.membrane);
    const lane = fx.strategy as unknown as { compressionPause: { backoffUntil: number; statedUntil: number | null; failures: number } | null };
    const pause = () => lane.compressionPause;
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(pause()?.failures, 1);
    pause()!.backoffUntil = 0;
    await fx.strategy.tick(ctx(fx.manager)); // answered: a refusal
    assert.equal(mock.calls.length, 2);
    assert.equal(pause(), null, 'the answer ended the pause');
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(pause()?.failures, 1, 'the next outage starts the backoff afresh');
    await fx.manager.close();
  });

  it("the merge's compression-log record bounds its error", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-log-'));
    const logPath = join(dir, 'compression.jsonl');
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    try {
      const huge = Object.assign(new Error(`zz ${'e'.repeat(1_000_000)}`), { type: 'network', retryable: true });
      const mock = scripted([{ error: huge }]);
      const fx = await fixture(mock.membrane);
      await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)));
      const records = readFileSync(logPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as { operation?: string; error?: string });
      const merge = records.filter((r) => typeof r.operation === 'string' && r.operation.startsWith('merge_l') && typeof r.error === 'string');
      assert.ok(merge.length > 0, 'the merge failure is logged');
      for (const r of merge) assert.ok(r.error!.length <= 2_000, `bounded: ${r.error!.length}`);
      await fx.manager.close();
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
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

// ── Further cases ───────────────────────────────────────────────────────────

describe('merge lane: classification, attribution and ownership', () => {
  after(cleanup);

  /** Wait for `n` provider calls, failing rather than hanging. */
  async function calledAtLeast(calls: unknown[], n: number, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (calls.length < n) {
      if (Date.now() > deadline) assert.fail(`the provider was called ${calls.length} time(s), not ${n}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  for (const type of ['context_length', 'invalid_request', 'safety', 'unsupported']) {
    it(`a ${type} rejection is evidence about the merge request: it spends an attempt and pauses nothing`, async () => {
      const rejection = Object.assign(new Error(`zz ${type}`), { type, retryable: false });
      const mock = scripted([{ error: rejection }]);
      const fx = await fixture(mock.membrane);
      await fx.strategy.tick(ctx(fx.manager)); // recorded, not thrown
      assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1, 'the bounded policy spent an attempt');
      const lane = fx.strategy as unknown as { compressionPause: unknown };
      assert.equal(lane.compressionPause, null, 'no lane pause');
      await fx.manager.close();
    });
  }

  it('a merge failure is the dispatched model\'s, not the one configured when it lands', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ config?: { model?: string } }> = [];
    const membrane = {
      complete: async (request: { config?: { model?: string } }) => {
        calls.push(structuredClone(request));
        if (calls.length === 1) {
          await gate;
          throw Object.assign(new Error('zz network down'), { type: 'network', retryable: true });
        }
        return { stopReason: 'end_turn', content: [t('merged under model B')], usage: { inputTokens: 100, outputTokens: 20 } };
      },
    } as never;
    const fx = await fixture(membrane);
    const tick = fx.strategy.tick(ctx(fx.manager));
    await calledAtLeast(calls, 1);
    assert.equal(calls[0]!.config?.model, MODEL);
    (fx.strategy as unknown as { config: { compressionModel: string } }).config.compressionModel = 'zz-model-b';
    release();
    await assert.rejects(tick, /zz network down/);
    const lane = fx.strategy as unknown as { compressionPause: { model?: string } | null };
    assert.equal(lane.compressionPause?.model, MODEL, 'the pause names the model the merge was sent to');
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(calls.length, 2, 'model B is not held by that failure');
    assert.equal(calls[1]!.config?.model, 'zz-model-b');
    await fx.manager.close();
  });

  it("a merge settling after other work took the lane leaves that work's ownership alone", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: unknown[] = [];
    const membrane = {
      complete: async (request: unknown) => {
        calls.push(request);
        await gate;
        return { stopReason: 'end_turn', content: [t('a merged parent')], usage: { inputTokens: 100, outputTokens: 20 } };
      },
    } as never;
    const fx = await fixture(membrane);
    const lane = fx.strategy as unknown as { pendingCompression: Promise<void> | null };
    const tick = fx.strategy.tick(ctx(fx.manager));
    await calledAtLeast(calls, 1);
    // As after a branch switch: newer work owns the lane while this merge is in flight.
    const newer = new Promise<void>(() => {});
    lane.pendingCompression = newer;
    release();
    await tick;
    assert.equal(lane.pendingCompression, newer, 'the newer work still owns the lane, so no second call can start');
    await fx.manager.close();
  });
});

describe('merge lane: answers, holds and landings', () => {
  after(cleanup);
  async function calledAtLeast(calls: unknown[], n: number, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (calls.length < n) {
      if (Date.now() > deadline) assert.fail(`the provider was called ${calls.length} time(s), not ${n}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  const network = () => Object.assign(new Error('zz network down'), { type: 'network', retryable: true });
  const lane = (fx: Fixture) => fx.strategy as unknown as {
    compressionPause: { backoffUntil: number; statedUntil: number | null; failures: number } | null;
    mergeQueue: Array<{ level: number; sourceIds: string[]; attempts?: number }>;
  };
  const answer = { stopReason: 'end_turn', content: [t('a merged parent')], usage: { inputTokens: 100, outputTokens: 20 } };

  it('a hold placed on the span during the call keeps the answer out with no failure: no pause, the entry stays queued, its run ends', async () => {
    let fx!: Fixture;
    const calls: unknown[] = [];
    const membrane = {
      complete: async (request: unknown) => {
        calls.push(request);
        if (calls.length === 1) throw network();
        // The provider answers; meanwhile a hold lands on a source's span.
        fx.manager.holdCompression([fx.manager.queryMessages({}).messages[1]!.id]);
        return answer;
      },
    } as never;
    fx = await fixture(membrane);
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(mergeRun(fx.strategy, lane(fx).mergeQueue[0])?.failures, 1, 'a run of one');
    lane(fx).compressionPause!.backoffUntil = 0;
    await fx.strategy.tick(ctx(fx.manager)); // answered, held: no throw
    assert.equal(calls.length, 2);
    assert.equal(lane(fx).compressionPause, null, 'the answer ended the pause, and the discard installed none');
    assert.equal(fx.strategy.mergeQueueView().length, 1, 'the entry stays queued for the release');
    assert.equal(mergeRun(fx.strategy, lane(fx).mergeQueue[0]), undefined, 'its run ended: the request answered');
    assert.equal(fx.strategy.summariesView().some((s) => s.level === 2), false, 'nothing written');
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(calls.length, 2, 'the held merge waits for the release');
    await fx.manager.close();
  });

  it("a refusal ends the run: the next failure starts a new one, and the refusal's attempt is synced", async () => {
    const mock = scripted([{ error: network() }, { stop: 'refusal' }, { error: network() }]);
    const fx = await fixture(mock.membrane);
    const store = fx.manager.getStore();
    const sync = store.sync.bind(store);
    // Each sync's view of the merge queue.
    const synced: unknown[] = [];
    store.sync = () => {
      synced.push(structuredClone(store.getStateJson('default/autobio:mergeQueue')));
      sync();
    };
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(mergeRun(fx.strategy, lane(fx).mergeQueue[0])?.failures, 1, 'a run of one');
    lane(fx).compressionPause!.backoffUntil = 0;
    (fx.strategy as unknown as { noteCompressionLanded(membrane: unknown, model: string): void }).noteCompressionLanded(ctx(fx.manager).membrane, MODEL);
    const beforeRefusal = synced.length;
    await fx.strategy.tick(ctx(fx.manager)); // a refusal: an answer
    assert.equal(mergeRun(fx.strategy, lane(fx).mergeQueue[0]), undefined, 'the answer ended the run');
    const refusalSyncs = synced.slice(beforeRefusal).map((queue) => (queue as Array<{ attempts?: number }> | null)?.[0]);
    assert.ok(refusalSyncs.some((entry) => entry?.attempts === 1), "the refusal's write is synced: its attempt counted");
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(mergeRun(fx.strategy, lane(fx).mergeQueue[0])?.failures, 1, 'a new run, though work landed before the refusal');
    await fx.manager.close();
  });

  it('a request-attributable rejection thrown as a plain object is recorded, not re-sent every tick', async () => {
    const rejection = { type: 'invalid_request', retryable: false, httpStatus: 400, message: 'zz plain-object 400' };
    const calls: unknown[] = [];
    const membrane = { complete: async (request: unknown) => { calls.push(request); throw rejection; } } as never;
    const fx = await fixture(membrane);
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, 1, 'recorded through the bounded policy');
    assert.equal(lane(fx).compressionPause, null, 'a rejection pauses nothing');
    await fx.manager.close();
  });

  it("an answer ends the entry's run even when the queue changed during the call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: unknown[] = [];
    const membrane = {
      complete: async (request: unknown) => {
        calls.push(request);
        if (calls.length === 1) throw network();
        await gate;
        return { stopReason: 'refusal', content: [], usage: { inputTokens: 100, outputTokens: 0 } };
      },
    } as never;
    const fx = await fixture(membrane);
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(lane(fx).mergeQueue.length, 1);
    const entry = lane(fx).mergeQueue[0]!;
    assert.equal(mergeRun(fx.strategy, entry)?.failures, 1, 'a run');
    lane(fx).compressionPause!.backoffUntil = 0;
    const tick = fx.strategy.tick(ctx(fx.manager));
    await calledAtLeast(calls, 2);
    // Another entry takes the head while the call is out.
    lane(fx).mergeQueue.unshift({ level: entry.level, sourceIds: ['zz-other-a', 'zz-other-b'] } as never);
    release();
    await tick;
    assert.equal(mergeRun(fx.strategy, entry), undefined, 'the answer ended its run');
    assert.ok(lane(fx).mergeQueue.includes(entry), 'the entry is still queued');
    await fx.manager.close();
  });

  it('a merge no longer queued leaves the failure order and its run', async () => {
    const fx = await fixture(scripted([{ stop: 'end_turn', text: 'unused' }]).membrane);
    const order = (fx.strategy as unknown as { mergeFailureOrder: Map<string, number> }).mergeFailureOrder;
    const runs = (fx.strategy as unknown as { mergeFailureRuns: Map<string, unknown> }).mergeFailureRuns;
    order.set('zz-a merge that left the queue', 1);
    runs.set('zz-a merge that left the queue', { key: 'zz', domain: 'zz', failures: 1, atLanded: 0 });
    (fx.strategy as unknown as { orderCompressionQueue(): void }).orderCompressionQueue();
    assert.equal(order.has('zz-a merge that left the queue'), false);
    assert.equal(runs.has('zz-a merge that left the queue'), false);
    await fx.manager.close();
  });

  it('an answer that arrives after a branch switch still ends the pause: the pause is the route\'s', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: unknown[] = [];
    const membrane = {
      complete: async (request: unknown) => {
        calls.push(request);
        if (calls.length === 1) throw network();
        await gate;
        return { stopReason: 'refusal', content: [], usage: { inputTokens: 100, outputTokens: 0 } };
      },
    } as never;
    const fx = await fixture(membrane);
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    const pause = lane(fx).compressionPause!;
    pause.backoffUntil = 0;
    const store = fx.manager.getStore();
    const fork = store.createBranchAt('zz-fork', fx.manager.currentBranch().name, store.currentSequence()).name;
    const tick = fx.strategy.tick(ctx(fx.manager));
    await calledAtLeast(calls, 2);
    await fx.manager.switchBranch(fork);
    release();
    await tick;
    assert.equal(lane(fx).compressionPause, null, 'the stale-branch answer ended the pause');
    await fx.manager.close();
  });

  it('a written merge is a landing in its domain: a failure of another merge there then counts', async () => {
    const calls: unknown[] = [];
    const membrane = {
      complete: async (request: unknown) => {
        calls.push(request);
        // The merge over L1-102 and L1-103 replays their raw messages.
        if (JSON.stringify(request).includes('raw-4 substance')) throw network();
        return answer;
      },
    } as never;
    const fx = await fixture(membrane, {}, freshPath(), false);
    const ids = fx.manager.queryMessages({}).messages.map((m) => m.id);
    const l1 = (id: string, a: number, b: number): SummaryEntry => ({
      id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0,
      sourceIds: [ids[a]!, ids[b]!], sourceRange: { first: ids[a]!, last: ids[b]! }, created: 1,
    });
    for (const [id, a, b] of [['L1-100', 0, 1], ['L1-101', 2, 3], ['L1-102', 4, 5], ['L1-103', 6, 7]] as const) fx.strategy.seed(l1(id, a, b));
    fx.strategy.qMerge(2, ['L1-102', 'L1-103']); // fails
    fx.strategy.qMerge(2, ['L1-100', 'L1-101']); // writes
    const failing = () => lane(fx).mergeQueue.find((entry) => (entry as unknown as { sourceIds: string[] }).sourceIds[0] === 'L1-102');
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(mergeRun(fx.strategy, failing())?.failures, 1);
    lane(fx).compressionPause!.backoffUntil = 0;
    await fx.strategy.tick(ctx(fx.manager)); // the other merge writes its parent: a landing
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 2), 'the other merge landed');
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(mergeRun(fx.strategy, failing())?.failures, 2, 'the landing made the next failure count');
    await fx.manager.close();
  });

  it('a merge written as the branch switches is still a landing in its domain', async () => {
    const membrane = {
      complete: async (request: unknown) => {
        if (JSON.stringify(request).includes('raw-4 substance')) throw network();
        return answer;
      },
    } as never;
    const fx = await fixture(membrane, {}, freshPath(), false);
    const ids = fx.manager.queryMessages({}).messages.map((m) => m.id);
    const l1 = (id: string, a: number, b: number): SummaryEntry => ({
      id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0,
      sourceIds: [ids[a]!, ids[b]!], sourceRange: { first: ids[a]!, last: ids[b]! }, created: 1,
    });
    for (const [id, a, b] of [['L1-100', 0, 1], ['L1-101', 2, 3], ['L1-102', 4, 5], ['L1-103', 6, 7]] as const) fx.strategy.seed(l1(id, a, b));
    fx.strategy.qMerge(2, ['L1-102', 'L1-103']); // fails
    fx.strategy.qMerge(2, ['L1-100', 'L1-101']); // writes
    const failing = () => lane(fx).mergeQueue.find((entry) => entry.sourceIds[0] === 'L1-102');
    await assert.rejects(() => fx.strategy.tick(ctx(fx.manager)), /zz network down/);
    assert.equal(mergeRun(fx.strategy, failing())?.failures, 1);
    lane(fx).compressionPause!.backoffUntil = 0;
    const store = fx.manager.getStore();
    const main = fx.manager.currentBranch().name;
    const fork = store.createBranchAt('zz-fork', main, store.currentSequence()).name;
    const probe = fx.strategy as unknown as { executeMerge(level: number, sourceIds: string[], c: StrategyContext): Promise<boolean> };
    const original = probe.executeMerge.bind(fx.strategy);
    let switched = false;
    probe.executeMerge = async (level, sourceIds, c) => {
      const wrote = await original(level, sourceIds, c);
      // The branch switches after the merge is written, before the tick resumes.
      await fx.manager.switchBranch(fork);
      switched = wrote;
      return wrote;
    };
    await fx.strategy.tick(ctx(fx.manager));
    probe.executeMerge = original;
    assert.equal(switched, true, 'the merge was written, then the branch switched before the tick went on');
    await fx.manager.switchBranch(main);
    let counted: number | undefined;
    for (let i = 0; i < 3 && counted === undefined; i++) {
      try {
        await fx.strategy.tick(ctx(fx.manager));
      } catch {
        counted = mergeRun(fx.strategy, failing())?.failures;
      }
    }
    assert.equal(counted, 2, "the merge written as the branch switched made the next failure count");
    await fx.manager.close();
  });
});
