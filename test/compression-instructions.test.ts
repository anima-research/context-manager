import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy, validateCompressionInstructions } from '../src/index.js';
import type { AutobiographicalOptions, CompressionInstructions, SummaryEntry, StrategyContext } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const instruction = (r: NormalizedRequest) => r.messages.at(-1)!.content
  .filter(b => b.type === 'text').map(b => b.text).join('\n');
const texts = (r: NormalizedRequest) => r.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text));
const custom: CompressionInstructions = {
  templates: {
    opening: 'CUSTOM OPEN',
    chunk: 'CUSTOM CHUNK {targetTokens}',
    witnessedChunk: 'CUSTOM WITNESS {targetTokens}',
    readingChunk: 'CUSTOM READ {totalTokens} {targetTokens}',
    merge: 'CUSTOM MERGE {sourceLevelShown} {targetLevel} {targetTokens}',
    witnessedMerge: 'CUSTOM WMERGE {sourceLevelShown} {targetLevel} {targetTokens}',
    readingMerge: 'CUSTOM RMERGE {sourceLevelShown} {targetLevel} {totalTokens} {targetTokens}',
    transition: 'CUSTOM TRANSITION {targetTokens}\n{context}',
  },
};
const options: AutobiographicalOptions = {
  compressionModel: 'mock-only', headWindowTokens: 0, recentWindowTokens: 0,
  targetChunkTokens: 100, minChunkCharsForLLM: 0, mergeThreshold: 99,
  autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0,
  compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
  compressionSplitFallback: true,
};
class Probe extends AutobiographicalStrategy {
  pin(value: number) { this.config.witnessedBeforeSequence = value; }
  compress(chunk: Chunk, ctx: StrategyContext) { return this.compressChunkHierarchical(chunk, ctx); }
  seed(s: SummaryEntry) { this.pushSummary(s); }
  async merge(ids: string[], ctx: StrategyContext, fallback = false) {
    if (!fallback) return this.executeMerge(2, ids, ctx);
    this.compressionQueue = []; // Isolate the seeded merge from unrelated shard work.
    this.enqueueMerge({ level: 2, sourceIds: ids });
    await this.tick(ctx);
    await this.tick(ctx);
    return this.summaries.some(s => s.level === 2);
  }
  summariesNow() { return this.summaries; }
}
type Mode = 'chunk' | 'reading' | 'split' | 'readingSplit' | 'merge' | 'readingMerge' | 'fallback' | 'readingFallback' | 'transition';
async function run(mode: Mode, pin: 'own' | 'mixed' | 'inherited', config?: CompressionInstructions,
  extra: AutobiographicalOptions = {}, Strategy = Probe) {
  const path = mkdtempSync(join(process.cwd(), 'test-instructions-'));
  const calls: NormalizedRequest[] = [];
  const reading = mode.startsWith('reading');
  const split = mode === 'split' || mode === 'readingSplit';
  const strategy = new Strategy({ ...options, adaptiveResolution: reading,
    ...(mode === 'transition' ? { headWindowTokens: 1000 } : {}),
    ...extra, compressionInstructions: config });
  const membrane = { complete: async (request: NormalizedRequest) => {
    calls.push(structuredClone(request));
    // Canonical/source-only split requests have four raw records. Pieces have one.
    const rawCount = texts(request).filter(s => s.startsWith('raw-')).length;
    return (split && rawCount > 1) || (mode.toLowerCase().includes('fallback') && calls.length === 1)
      ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 } }
      : { content: [text('A mock summary.')], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
  } };
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  try {
    if (reading) {
      manager.addMessage('Reader', [text('raw-portion substantive shared text. '.repeat(200))]);
    } else {
      for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Participant' : 'Other', [text(`raw-${i} {participant} {targetTokens} $& ` + 'substantive '.repeat(15))]);
    }
    const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    const messages = ctx.messageStore.getAll();
    if (reading) assert.ok(messages.length > 8, 'fixture really is sharded');
    strategy.pin(pin === 'inherited' ? messages.at(-1)!.sequence + 1 : messages[pin === 'mixed' ? 2 : 0]!.sequence);
    const before = structuredClone(messages);
    if (['chunk', 'reading', 'split', 'readingSplit'].includes(mode)) {
      const chosen = reading && !split ? messages.slice(0, 1) : messages.slice(0, 4);
      await strategy.compress({ index: 0, startIndex: 0, endIndex: chosen.length,
        messages: chosen, tokens: 100, compressed: false }, ctx);
      assert.equal(strategy.summariesNow().length, 1, 'compression installed one native summary');
    } else if (mode === 'transition') {
      await strategy.generateTransitionSummary(ctx);
    } else {
      const sources = [0, 2].map((start, i): SummaryEntry => ({
        id: `L1-${100 + i}`, level: 1, content: `attributed source ${i}`, tokens: 20,
        sourceLevel: 0, sourceIds: messages.slice(start, start + 2).map(m => m.id),
        sourceRange: { first: messages[start]!.id, last: messages[start + 1]!.id }, created: 1,
        ...(pin === 'inherited' || (pin === 'mixed' && i === 0) ? { witnessed: true } : {}),
      }));
      for (const s of sources) strategy.seed(s);
      assert.equal(await strategy.merge(sources.map(s => s.id), ctx, mode.toLowerCase().includes('fallback')), true);
      const merged = strategy.summariesNow().find(s => s.level === 2)!;
      assert.ok(merged, 'merge was actually installed');
      assert.equal(!!merged.witnessed, pin === 'inherited');
      assert.deepEqual(merged.sourceIds, sources.map(s => s.id));
    }
    assert.deepEqual(ctx.messageStore.getAll(), before, 'raw content and metadata untouched');
    assert.equal(calls.length, split ? 8 : mode.toLowerCase().includes('fallback') ? 2 : 1, 'only the expected mock calls');
    return calls;
  } finally {
    await manager.close();
    rmSync(path, { recursive: true, force: true });
  }
}

for (const mode of ['chunk', 'reading', 'split', 'readingSplit', 'merge', 'readingMerge', 'fallback', 'readingFallback', 'transition'] as const) {
  for (const pin of ['own', 'mixed', 'inherited'] as const) {
    it(`${mode}/${pin}: omitted and DEFAULT requests are byte-identical`, async () => {
      assert.deepEqual(await run(mode, pin), await run(mode, pin, { preset: 'default' }));
    });
  }
}

for (const mode of ['chunk', 'reading', 'split', 'readingSplit', 'merge', 'readingMerge', 'fallback', 'readingFallback', 'transition'] as const) {
  for (const pin of ['own', 'mixed', 'inherited'] as const) {
    it(`${mode}/${pin}: template-only instructions reach the actual request, not the stored data`, async () => {
      const calls = await run(mode, pin, custom);
      for (const [index, request] of calls.entries()) {
        const s = instruction(request);
        const shown = mode.toLowerCase().includes('fallback') && index === 1 ? 1 : 0;
        if (mode === 'transition') assert.match(s, /^CUSTOM TRANSITION 1500\n/);
        else if (mode === 'readingMerge' || mode === 'readingFallback') {
          assert.match(s, new RegExp(`^CUSTOM RMERGE ${shown} 2 \\d+ \\d+$`));
        } else if (mode === 'merge' || mode === 'fallback') {
          assert.match(s, new RegExp(`^CUSTOM ${pin === 'inherited' ? 'WMERGE' : 'MERGE'} ${shown} 2 \\d+$`));
        } else if (mode === 'reading' || (mode === 'readingSplit' && index < 2)) {
          // Canonical/source-only calls use reading; all split attempts use chunk hooks.
          assert.match(s, /^CUSTOM READ \d+ \d+$/);
        } else assert.match(s, pin === 'inherited' ? /^CUSTOM WITNESS \d+$/ : /^CUSTOM CHUNK \d+$/);
        if (mode === 'split' || mode === 'readingSplit' || mode === 'chunk' || mode === 'reading') {
          assert.ok(texts(request).includes('CUSTOM OPEN'));
        }
      }
    });
  }
}

it('every custom slot substitutes typed values; transition data and participant are nonrecursive', async () => {
  const config: CompressionInstructions = {
    participant: 'Participant {targetTokens} $&',
    templates: {
      opening: 'OPEN {participant}', chunk: 'CHUNK {participant} {targetTokens} {targetTokens}',
      witnessedChunk: 'WITNESS {targetTokens}', readingChunk: 'READ {totalTokens} {targetTokens}',
      merge: 'MERGE {sourceLevelShown} {targetLevel} {targetTokens}',
      witnessedMerge: 'WMERGE {sourceLevelShown} {targetLevel} {targetTokens}',
      readingMerge: 'RMERGE {sourceLevelShown} {targetLevel} {totalTokens} {targetTokens}',
      transition: 'TRANSITION {targetTokens}\nDATA {context}\nEND',
    },
  };
  const chunk = (await run('chunk', 'own', config))[0]!;
  assert.match(instruction(chunk), /^CHUNK Participant \{targetTokens\} \$& (\d+) \1$/);
  assert.ok(texts(chunk).includes('OPEN Participant {targetTokens} $&'));
  assert.match(instruction((await run('chunk', 'inherited', config))[0]!), /^WITNESS \d+$/);
  assert.match(instruction((await run('reading', 'inherited', config))[0]!), /^READ \d+ \d+$/);
  for (const mode of ['merge', 'fallback'] as const) {
    const shown = mode === 'merge' ? 0 : 1;
    assert.match(instruction((await run(mode, 'mixed', config)).at(-1)!), new RegExp(`^MERGE ${shown} 2 \\d+$`));
    assert.match(instruction((await run(mode, 'inherited', config)).at(-1)!), new RegExp(`^WMERGE ${shown} 2 \\d+$`));
  }
  for (const mode of ['readingMerge', 'readingFallback'] as const) {
    assert.match(instruction((await run(mode, 'inherited', config)).at(-1)!), new RegExp(`^RMERGE ${mode === 'readingMerge' ? 0 : 1} 2 \\d+ \\d+$`));
  }
  const transition = instruction((await run('transition', 'own', config))[0]!);
  assert.match(transition, /^TRANSITION 1500\nDATA /);
  assert.match(transition, /raw-0 \{participant\} \{targetTokens\} \$&/);
  assert.ok(transition.endsWith('\nEND'));
});

it('invalid configuration fails synchronously before any provider can be called, without leaking values', () => {
  for (const value of [null, [], 'secret', { preset: 'unregistered-preset' }, { preset: 'DEFAULT' }, { preset: 1 }, { preset: null },
    { participant: '' }, { participant: 1 }, { participant: null }, { typo: 'secret' },
    { templates: {} }, { templates: [] }, { templates: { typo: 'secret' } },
    ...['', '  ', 42, null, {}, [], () => 'secret', '{', '}', '{{participant}}', '{targetToken}', '{unknown}', '{totalTokens}', '{participant}'].map(chunk => ({ templates: { chunk } })),
    { templates: { transition: 'no data' } }, { templates: { transition: '{context}{context}' } },
    { templates: { opening: '{targetTokens}' } },
  ]) {
    assert.throws(() => new Probe({ compressionInstructions: value as never }), { name: 'TypeError', message: 'Invalid compressionInstructions configuration' });
  }
  validateCompressionInstructions(JSON.parse(JSON.stringify(custom)));
  assert.throws(() => new Probe({ witnessedInstruction: 'old', compressionInstructions: { templates: { witnessedChunk: 'new' } } }), /Conflicting witnessed instruction configuration/);
});

it('existing hooks and reminders keep their precedence', async () => {
  class Custom extends Probe {
    protected override getCompressionInstruction() { return 'SUBCLASS'; }
    protected override getReadingChunkInstruction() { return 'READ-SUBCLASS'; }
    protected override getMergeInstruction() { return 'MERGE-SUBCLASS'; }
    protected override getReadingMergeInstruction() { return 'READ-MERGE-SUBCLASS'; }
    protected override getSourceMergeInstruction() { return 'SOURCE-SUBCLASS'; }
  }
  for (const [mode, expected] of [['chunk', 'SUBCLASS'], ['reading', 'READ-SUBCLASS'], ['merge', 'MERGE-SUBCLASS'],
    ['readingMerge', 'READ-MERGE-SUBCLASS'], ['fallback', 'SOURCE-SUBCLASS']] as const) {
    const calls = await run(mode, 'own', custom, { identityReminder: 'REMINDER' }, Custom);
    assert.equal(instruction(calls.at(-1)!), `${expected}\n\nREMINDER`);
  }
  const calls = await run('chunk', 'inherited', { templates: { chunk: 'UNUSED CUSTOM CHUNK' } }, { witnessedInstruction: 'EXISTING {targetTokens}', witnessedIdentityReminder: 'WITNESS-REMINDER' });
  assert.match(instruction(calls[0]!), /^EXISTING \d+\n\nWITNESS-REMINDER$/);
});


it('templates alone need no preset; partial overrides leave every other phase at DEFAULT', async () => {
  const config: CompressionInstructions = { templates: { chunk: 'ONLY CHUNK {targetTokens}' } };
  assert.match(instruction((await run('chunk', 'own', config))[0]!), /^ONLY CHUNK \d+$/);
  for (const [mode, pin] of [['chunk', 'inherited'], ['reading', 'own'], ['merge', 'own'],
    ['fallback', 'inherited'], ['readingFallback', 'own'], ['transition', 'own']] as const) {
    assert.deepEqual(await run(mode, pin, config), await run(mode, pin));
  }
  const pieces = await run('readingSplit', 'mixed', config);
  for (const r of pieces.slice(-4)) assert.match(instruction(r), /^ONLY CHUNK \d+$/);
});

it('constructor snapshots templates; later caller edits cannot reach request hooks', () => {
  class Expose extends Probe {
    opening() { return this.getCompressionOpening(); }
  }
  const config: CompressionInstructions = { templates: { opening: 'checked text' } };
  const strategy = new Expose({ compressionInstructions: config });
  config.templates!.opening = '{unsupported}';
  assert.equal(strategy.opening(), 'checked text');
});

it('empty settings and an unused explicit participant do not select new wording', async () => {
  for (const config of [{}, { participant: 'Explicit actor' }, { preset: 'default', participant: 'Explicit actor' }] as CompressionInstructions[]) {
    assert.deepEqual(await run('chunk', 'own', config), await run('chunk', 'own'));
  }
});

it('only the registered default preset is accepted, including with complete templates', () => {
  validateCompressionInstructions({ preset: 'default' });
  validateCompressionInstructions({ ...custom, preset: 'default' });
  for (const preset of ['unregistered-preset', 'DEFAULT', '', '__proto__', 'constructor']) {
    for (const config of [{ preset }, { ...custom, preset, participant: 'Explicit actor' }]) {
      assert.throws(() => validateCompressionInstructions(config), {
        name: 'TypeError', message: 'Invalid compressionInstructions configuration',
      });
      assert.throws(() => new Probe({ compressionInstructions: config as never }), {
        name: 'TypeError', message: 'Invalid compressionInstructions configuration',
      });
    }
  }
});

it('participant is explicit and required only by custom placeholders, never inferred from summary ownership', () => {
  for (const slot of ['opening', 'chunk', 'witnessedChunk', 'readingChunk', 'merge', 'witnessedMerge', 'readingMerge', 'transition'] as const) {
    const template = slot === 'transition' ? '{participant} {context}' : '{participant}';
    assert.throws(() => new Probe({ summaryParticipant: 'Not an implicit actor',
      compressionInstructions: { templates: { [slot]: template } } }), {
      name: 'TypeError', message: 'Invalid compressionInstructions configuration',
    });
    validateCompressionInstructions({ participant: 'Explicit actor', templates: { [slot]: template } });
  }
});

it('explicit default still permits custom overrides', async () => {
  assert.deepEqual(await run('chunk', 'own', { ...custom, preset: 'default' }), await run('chunk', 'own', custom));
});
