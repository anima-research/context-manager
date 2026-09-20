import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';
import { hoistToolProse, toolProseStub, DEFAULT_TOOL_PROSE_RESULT } from '../src/tool-prose-hoist.js';

// Tool-prose hoist rung (2026-09-19, sill). Long prose in a private-reasoning
// tool argument (skip_reply.reason) gets an L1 request refused regardless of
// content; the rung retries with the prose moved into a REAL note-taking tool.

const BASE = './test-tool-prose-hoist';
let sequence = 0;
const paths: string[] = [];
function freshPath(): string { const p = `${BASE}-${sequence++}`; paths.push(p); return p; }
after(() => { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); });

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const DIARY = 'I weighed the thread and decided to stay quiet. '.repeat(12); // ~580 chars
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id, name, input } as ContentBlock);
const result = (id: string, content: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content } as ContentBlock);

const OPTS = { intoTool: 'journal', field: 'content', result: DEFAULT_TOOL_PROSE_RESULT, minChars: 100, fromTools: ['skip_reply'] };

function toolUses(req: { messages: Array<{ content: ContentBlock[] }> }) {
  return req.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_use') as Array<ContentBlock & { id: string; name: string; input: Record<string, unknown> }>);
}

describe('hoistToolProse (pure)', () => {
  const messages = [
    { participant: 'User', content: [text('hello')] },
    { participant: 'Claude', content: [text('said aloud'), use('t1', 'skip_reply', { reason: DIARY, wake_in_seconds: 1500 })] },
    { participant: 'User', content: [result('t1', '{"skipped":true}'), text('next event')] },
  ];

  it('moves the prose into its own round of the real tool, just before the original call', () => {
    const { messages: out, hoisted } = hoistToolProse(messages, OPTS);
    assert.equal(hoisted, 1);
    assert.equal(out.length, 5);
    assert.deepEqual(out[1], { participant: 'Claude', content: [use('t1_0', 'journal', { content: DIARY })] });
    assert.deepEqual(out[2], { participant: 'User', content: [result('t1_0', DEFAULT_TOOL_PROSE_RESULT)] });
    const original = out[3]!.content[1] as ContentBlock & { input: Record<string, unknown> };
    assert.equal(original.input.reason, toolProseStub('journal', DIARY.length));
    assert.equal(original.input.wake_in_seconds, 1500, 'other arguments untouched');
    assert.deepEqual(out[3]!.content[0], text('said aloud'), 'assistant text stays where it was');
    assert.equal(out[4], messages[2], 'untouched messages keep their identity');
    // nothing the agent wrote is dropped
    assert.ok(JSON.stringify(out).includes(DIARY));
    // input was not mutated
    assert.equal((messages[1]!.content[1] as unknown as { input: { reason: string } }).input.reason, DIARY);
  });

  it('is deterministic (stable request hash)', () => {
    assert.deepEqual(hoistToolProse(messages, OPTS), hoistToolProse(messages, OPTS));
  });

  it('NEGATIVE: short arguments, other tools, the target tool itself, and unpaired calls are left alone', () => {
    const others = [
      { participant: 'Claude', content: [use('a', 'skip_reply', { reason: 'nothing to add' })] },
      { participant: 'User', content: [result('a', 'ok')] },
      { participant: 'Claude', content: [use('b', 'mcpl--discord--send_message', { channelId: 'c', content: DIARY })] },
      { participant: 'User', content: [result('b', 'ok')] },
      { participant: 'Claude', content: [use('c', 'journal', { content: DIARY })] },
      { participant: 'User', content: [result('c', 'ok')] },
      { participant: 'Claude', content: [use('d', 'skip_reply', { reason: DIARY })] }, // no tool_result
    ];
    const { messages: out, hoisted } = hoistToolProse(others, { ...OPTS, fromTools: ['skip_reply', 'journal'] });
    assert.equal(hoisted, 0);
    assert.deepEqual(out, others);
  });

  it('matches a namespaced tool by its final segment', () => {
    const ns = [
      { participant: 'Claude', content: [use('n', 'agent--think', { content: DIARY })] },
      { participant: 'User', content: [result('n', 'ok')] },
    ];
    assert.equal(hoistToolProse(ns, { ...OPTS, fromTools: ['think'] }).hoisted, 1);
  });
});

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}
const tool = (name: string): ToolDefinition => ({ name, description: 'd', inputSchema: { type: 'object', properties: {} } } as never);
const REFUSAL = { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'reasoning_extraction' } } } };
const OK = (t: string) => ({ content: [text(t)], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } });

interface Opts { hoist?: boolean; sourceOnlyFallback?: boolean; tools?: string[]; reason?: string; path?: string; }
function config(opts: Opts) {
  return {
    compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 0,
    compressionSourceOnlyFallback: opts.sourceOnlyFallback,
    ...(opts.hoist ? { compressionToolProseFallback: { intoTool: 'journal', fromTools: ['skip_reply'] } } : {}),
  } as never;
}
async function build(membrane: unknown, opts: Opts = {}) {
  const strategy = new ProbeStrategy(config(opts));
  const manager = await ContextManager.open({ path: opts.path ?? freshPath(), strategy, membrane: membrane as never });
  manager.setToolDefinitions((opts.tools ?? ['skip_reply', 'journal']).map(tool));
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
  ids.push(manager.addMessage('User', [text('raw-10 ambient chatter ' + 'substantive '.repeat(12))]));
  ids.push(manager.addMessage('Claude', [use('skip1', 'skip_reply', { reason: opts.reason ?? DIARY, wake_in_seconds: 1500 })]));
  ids.push(manager.addMessage('User', [result('skip1', '{"skipped":true}')]));
  strategy.seed({ id: 'L1-100', level: 1, content: 'authored L1-100', tokens: 20, sourceLevel: 0, sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! }, created: 100 });
  return { manager, strategy, ids, target: () => targetOf(manager, ids) };
}
function targetOf(manager: ContextManager, ids: string[]): Chunk {
  const want = new Set(ids.slice(10));
  return { index: 999, startIndex: 10, endIndex: 13, messages: managerContext(manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false };
}
function scripted(responses: Array<typeof REFUSAL | ReturnType<typeof OK>>) {
  const calls: NormalizedRequest[] = []; let n = 0;
  return { calls, membrane: { complete: async (request: NormalizedRequest) => { calls.push(structuredClone(request)); return responses[Math.min(n++, responses.length - 1)]; } } as never };
}

// The fixture's large head window replays the chunk's messages in the head as
// well as in the target slot, so canonical requests carry each call twice.
const names = (req: NormalizedRequest): string => [...new Set(toolUses(req).map((u) => u.name))].join('+');

describe('tool-prose hoist rung', () => {
  it('RUNG: canonical refusal → one hoisted canonical retry, which lands the memory', async () => {
    const { calls, membrane } = scripted([REFUSAL, OK('hoisted memory')]);
    const fx = await build(membrane, { hoist: true });
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(calls.length, 2);
    assert.equal(names(calls[0]!), 'skip_reply', 'canonical is untouched');
    assert.ok(toolUses(calls[0]!).every((u) => u.input.reason === DIARY));
    assert.equal(names(calls[1]!), 'journal+skip_reply');
    for (const u of toolUses(calls[1]!)) {
      if (u.name === 'journal') assert.equal(u.input.content, DIARY);
      else assert.equal(u.input.reason, toolProseStub('journal', DIARY.length), 'no long argument survives anywhere in the request');
    }
    // full canonical context kept: same head/recall text on both calls
    const flat = (r: NormalizedRequest) => r.messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    assert.deepEqual(flat(calls[1]!), flat(calls[0]!));
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
  });

  it('INVARIANT: canonical success never triggers the rung; canonical bytes identical with the option on vs off', async () => {
    const on = scripted([OK('m')]); const off = scripted([OK('m')]);
    const a = await build(on.membrane, { hoist: true }); await a.strategy.run(a.target(), managerContext(a.manager));
    const b = await build(off.membrane, { hoist: false }); await b.strategy.run(b.target(), managerContext(b.manager));
    assert.equal(on.calls.length, 1); assert.equal(off.calls.length, 1);
    const strip = (r: NormalizedRequest) => JSON.stringify(r.messages.map((m) => m.content.map((blk) => ({ ...blk, id: undefined, toolUseId: undefined }))));
    assert.equal(strip(on.calls[0]!), strip(off.calls[0]!));
  });

  it('GUARD: skipped when the target tool is not declared (never show a tool the agent does not have)', async () => {
    const { calls, membrane } = scripted([REFUSAL]);
    const fx = await build(membrane, { hoist: true, tools: ['skip_reply'] });
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(calls.length, 1);
    assert.ok(fx.strategy.getCompressionQuarantineStatus().count >= 1);
  });

  it('GUARD: nothing to hoist → no identical burned retry', async () => {
    const { calls, membrane } = scripted([REFUSAL]);
    const fx = await build(membrane, { hoist: true, reason: 'nothing to add' });
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(calls.length, 1);
  });

  it('ORDER + BOUND: canonical → hoist → source-only → source-only hoist, then quarantine', async () => {
    const { calls, membrane } = scripted([REFUSAL]);
    const fx = await build(membrane, { hoist: true, sourceOnlyFallback: true });
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.deepEqual(calls.map(names),
      ['skip_reply', 'journal+skip_reply', 'skip_reply', 'journal+skip_reply']);
    assert.ok(calls[2]!.messages.length < calls[0]!.messages.length, 'third call is source-only');
    assert.ok(calls[3]!.messages.length < calls[1]!.messages.length, 'fourth call is source-only, hoisted');
    assert.ok(fx.strategy.getCompressionQuarantineStatus().count >= 1);
  });

  it('FAMILY: enabling the rung gives an already-quarantined chunk a fresh attempt without a manual clear', async () => {
    const path = freshPath();
    const first = scripted([REFUSAL]);
    const a = await build(first.membrane, { hoist: false, path });
    await a.strategy.run(a.target(), managerContext(a.manager));
    assert.ok(a.strategy.getCompressionQuarantineStatus().count >= 1);
    // same regime: sticky, no new call
    await a.strategy.run(a.target(), managerContext(a.manager));
    assert.equal(first.calls.length, 1);
    a.manager.close();

    const second = scripted([REFUSAL, OK('fresh family')]);
    const strategy = new ProbeStrategy(config({ hoist: true }));
    const manager = await ContextManager.open({ path, strategy, membrane: second.membrane });
    manager.setToolDefinitions(['skip_reply', 'journal'].map(tool));
    await strategy.run(targetOf(manager, a.ids), managerContext(manager));
    assert.equal(second.calls.length, 2, 'canonical then hoisted');
    manager.close();
  });
});
