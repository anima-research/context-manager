import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Membrane,
  NativeFormatter,
  errorFromProviderStatus,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderRequestOptions,
  type ProviderResponse,
  type StreamCallbacks,
} from '@animalabs/membrane';
import { ContextManager } from '../src/context-manager.js';
import { AutobiographicalStrategy } from '../src/index.js';
import { generateWorkload } from './_harness/workload.js';

const BINDING_MODEL = 'claude-opus-5-5';
const REFUSAL = 'Invalid `signature` in `thinking` block. The block is bound to a different conversation.';

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'cache_control') out[k] = withoutCacheControl(v);
    return out;
  }
  return value;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(withoutCacheControl(v))).digest('hex').slice(0, 16);
const isThinking = (b: unknown) => ['thinking', 'redacted_thinking'].includes((b as { type?: string }).type ?? '');

/** A value with every thinking block taken out of every content list in it. */
function withoutThinking(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !isThinking(v)).map(withoutThinking);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = withoutThinking(v);
    return out;
  }
  return value;
}

/** The wire messages without any thinking block, and without a message that held nothing else. */
function stripped(messages: unknown[]): unknown[] {
  return messages
    .map((m) => {
      const message = m as { content?: unknown };
      return Array.isArray(message.content) ? { ...message, content: message.content.filter((b) => !isThinking(b)) } : message;
    })
    .filter((m) => !Array.isArray((m as { content?: unknown }).content) || ((m as { content: unknown[] }).content.length > 0));
}

interface Call {
  request: unknown;
  messages: unknown[];
  carriers: number;
  refused: boolean;
}

/**
 * The provider, for a model that binds its thinking: an answer leads with an
 * empty thinking block signed for its request's conversation, and an account
 * that enforces the binding refuses a request carrying a block whose earlier
 * conversation differs, unless the request carries the drop control.
 */
class BindingProvider implements ProviderAdapter {
  readonly name = 'binding-provider';
  readonly reportsContentAlterations = true;
  readonly usageCacheConvention = 'cache-excluded' as const;
  readonly calls: Call[] = [];
  constructor(private readonly enforces: boolean) {}
  supportsModel(): boolean { return true; }

  private conversation(request: ProviderRequest, upTo: number): string {
    return digest({ model: request.model, system: request.system ?? null, tools: request.tools ?? null, messages: request.messages.slice(0, upTo) });
  }

  async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    options?.onRequest?.(request);
    let carriers = 0;
    let mismatched: string | undefined;
    request.messages.forEach((m, i) => {
      const content = (m as { content?: unknown }).content;
      if (!Array.isArray(content)) return;
      content.forEach((b, j) => {
        if (!isThinking(b)) return;
        carriers++;
        if ((b as { signature?: string }).signature !== `bound:${this.conversation(request, i)}`) mismatched ??= `messages.${i}.content.${j}`;
      });
    });
    const thinking = ((request.extra as { thinking?: unknown } | undefined)?.thinking ?? request.thinking) as
      { block_binding?: { prefix_mismatch_behavior?: string } } | undefined;
    const refused = this.enforces && mismatched !== undefined && thinking?.block_binding?.prefix_mismatch_behavior !== 'drop_block';
    this.calls.push({ request: structuredClone({ ...request, messages: undefined }), messages: structuredClone(request.messages), carriers, refused });
    if (refused) {
      const body = { type: 'error', error: { type: 'invalid_request_error', message: `${mismatched}: ${REFUSAL}` } };
      throw errorFromProviderStatus({ provider: 'anthropic', status: 400, body, message: `400 ${JSON.stringify(body)}` });
    }
    const text = `<memory>digest ${digest(stripped(request.messages).at(-1))}</memory>`;
    const content = [{ type: 'thinking', thinking: '', signature: `bound:${this.conversation(request, request.messages.length)}` }, { type: 'text', text }];
    return {
      content,
      stopReason: 'end_turn',
      usage: { inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4), outputTokens: 20 },
      model: request.model,
      rawRequest: request,
      raw: { content },
    } as ProviderResponse;
  }

  async stream(request: ProviderRequest, _callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.complete(request, options);
  }
}

interface Run {
  calls: Call[];
  summaries: Array<{ level: number; content: string; carries: boolean }>;
  queued: number;
  errorLines: string[];
  allErrorLines: string[];
}

async function run(enforces: boolean): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), 'cm-binding-refusal-'));
  const provider = new BindingProvider(enforces);
  const strategy = new AutobiographicalStrategy({
    compressionModel: BINDING_MODEL,
    targetChunkTokens: 500,
    recentWindowTokens: 600,
    headWindowTokens: 0,
    mergeThreshold: 3,
  });
  const errorLines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { errorLines.push(parts.map(String).join(' ')); };
  let manager: ContextManager | undefined;
  try {
    manager = await ContextManager.open({
      path: join(root, 'store.chronicle'),
      strategy,
      membrane: new Membrane(provider, { formatter: new NativeFormatter() }),
    });
    manager.setToolDefinitions([{ name: 'fake_tool', description: 'synthetic workload tool', inputSchema: { type: 'object', properties: {} } }]);
    for (const turn of generateWorkload({ turns: 150, avgUserTokens: 40, avgAssistantTokens: 80, toolCallProbability: 0.3, seed: 4242 })) {
      manager.addMessage(turn.participant, turn.content);
      for (let k = 0; k < 10 && !manager.isReady(); k++) await manager.tick();
      await manager.tick();
      await manager.compile({ maxTokens: 100_000, reserveForResponse: 2000 });
    }
    for (let k = 0; k < 20; k++) await manager.tick();
    const internals = strategy as unknown as {
      summaries: Array<{ level: number; content: string; responseContent?: unknown[] }>;
      compressionQueue: unknown[];
    };
    return {
      calls: provider.calls,
      summaries: internals.summaries.map((s) => ({ level: s.level, content: s.content, carries: (s.responseContent ?? []).some(isThinking) })),
      queued: internals.compressionQueue.length,
      errorLines: errorLines.filter((line) => line.includes('transport rejected reasoning carriers')),
      allErrorLines: errorLines,
    };
  } finally {
    console.error = original;
    manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('summarizer requests on a model that binds its thinking', () => {
  it('under an account that enforces the binding, the first refusal teaches the strategy, and each later compression or merge is sent once, without carriers', async () => {
    const enforcing = await run(true);
    const showing = await run(false);
    assert.ok(showing.calls.filter((call) => call.carriers > 0).length > 1, 'premise: the recall pairs carry carriers');
    assert.ok(showing.summaries.some((s) => s.level > 1), 'premise: merges ran');
    assert.equal(enforcing.calls.filter((call) => call.refused).length, 1, 'one refusal');
    assert.equal(enforcing.calls.length, showing.calls.length + 1, 'one call per compression, and the refused one');
    assert.deepEqual(enforcing.summaries.map((s) => [s.level, s.content]), showing.summaries.map((s) => [s.level, s.content]), 'the same summaries');
    assert.equal(enforcing.queued, 0);
    assert.equal(enforcing.errorLines.length, 1, 'one error line, for the refusal that taught it');
    assert.equal(enforcing.allErrorLines.length, 1, 'and no other');
    assert.ok(enforcing.summaries.every((s) => s.carries), 'carriers are still captured');
  });

  it('the requests an enforcing account accepts are those an account that shows the blocks is sent, without their thinking', async () => {
    const enforcing = await run(true);
    const showing = await run(false);
    const accepted = enforcing.calls.filter((call) => !call.refused).map((call) => ({ request: call.request, messages: call.messages }));
    assert.ok(accepted.length > 2, 'premise: summarizer calls ran');
    assert.deepEqual(accepted, showing.calls.map((call) => ({ request: withoutThinking(call.request), messages: stripped(call.messages) })));
  });

  it('an account that shows the blocks is never refused, and its summarizer requests still carry carriers', async () => {
    const showing = await run(false);
    assert.ok(showing.calls.length > 2, 'premise: summarizer calls ran');
    assert.equal(showing.calls.filter((call) => call.refused).length, 0);
    assert.equal(showing.allErrorLines.length, 0, 'no error');
    const withCarriers = showing.calls.filter((call) => call.carriers > 0).length;
    assert.ok(withCarriers >= showing.calls.length - 2, `recall pairs carry their carriers: ${withCarriers} of ${showing.calls.length}`);
  });
});
