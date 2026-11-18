import { requestBytes } from './compression-golden-reader.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompressionInstructions } from '../src/index.js';
import { resolveEffectiveConfig } from '../src/config-provenance.js';
import { compressionInstruction } from '../src/compression-instructions.js';
import type { CompressionInstructions, SummaryLevel, SummaryEntry } from '../src/index.js';
import { Probe, KnowledgeProbe, run, custom, instruction, texts } from './compression-instructions-harness.js';

for (const mode of ['chunk', 'reading', 'split', 'readingSplit', 'merge', 'readingMerge', 'fallback', 'readingFallback', 'transition'] as const) {
  for (const pin of ['own', 'mixed', 'inherited'] as const) {
    it(`${mode}/${pin}: omitted and DEFAULT requests are byte-identical`, async () => {
      assert.equal(requestBytes(await run(mode, pin)), requestBytes(await run(mode, pin, { preset: 'default' })));
    });
  }
}

for (const mode of ['chunk', 'reading', 'split', 'readingSplit', 'merge', 'readingMerge', 'fallback', 'readingFallback', 'transition'] as const) {
  for (const pin of ['own', 'mixed', 'inherited'] as const) {
    it(`${mode}/${pin}: template-only instructions reach the actual request, not the stored data`, async () => {
      const calls = await run(mode, pin, custom);
      for (const [index, request] of calls.entries()) {
        const s = instruction(request);
        const target = mode === 'split' || mode === 'readingSplit' ? [2000, 2000, 1000, 500, 500, 1000, 500, 500][index] : 2000;
        const shown = mode.toLowerCase().includes('fallback') && index === 1 ? 1 : 0;
        if (mode === 'transition') assert.match(s, /^CUSTOM TRANSITION 1500\n/);
        else if (mode === 'readingMerge' || (mode === 'readingFallback' && index === 0)) {
          assert.match(s, new RegExp(`^CUSTOM RMERGE ${shown} 2 2560 2000$`));
        } else if (mode === 'merge' || mode === 'fallback' || mode === 'readingFallback') {
          assert.match(s, new RegExp(`^CUSTOM ${pin === 'inherited' ? 'WMERGE' : 'MERGE'} ${shown} 2 2000$`));
        } else if (mode === 'reading' || (mode === 'readingSplit' && index < 2)) {
          // Canonical/source-only calls use reading; all split attempts use chunk hooks.
          assert.equal(s, 'CUSTOM READ 2560 2000');
        } else assert.equal(s, `CUSTOM ${pin === 'inherited' ? 'WITNESS' : 'CHUNK'} ${target}`);
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
  assert.match(instruction(chunk), /^CHUNK Participant \{targetTokens\} \$& 2000 2000$/);
  assert.ok(texts(chunk).includes('OPEN Participant {targetTokens} $&'));
  assert.match(instruction((await run('chunk', 'inherited', config))[0]!), /^WITNESS 2000$/);
  assert.match(instruction((await run('reading', 'inherited', config))[0]!), /^READ 2560 2000$/);
  for (const mode of ['merge', 'fallback'] as const) {
    const shown = mode === 'merge' ? 0 : 1;
    assert.match(instruction((await run(mode, 'mixed', config)).at(-1)!), new RegExp(`^MERGE ${shown} 2 2000$`));
    assert.match(instruction((await run(mode, 'inherited', config)).at(-1)!), new RegExp(`^WMERGE ${shown} 2 2000$`));
  }
  for (const mode of ['readingMerge', 'readingFallback'] as const) {
    assert.match(instruction((await run(mode, 'inherited', config)).at(-1)!), mode === 'readingMerge' ? /^RMERGE 0 2 2560 2000$/ : /^WMERGE 1 2 2000$/);
  }
  const transition = instruction((await run('transition', 'own', config))[0]!);
  assert.match(transition, /^TRANSITION 1500\nDATA /);
  const context = Array.from({ length: 4 }, (_, i) => `${i % 2 ? 'Participant' : 'Other'}: raw-${i} {participant} {targetTokens} $& ` + 'substantive '.repeat(15)).join('\n\n');
  assert.equal(transition, `TRANSITION 1500\nDATA ${context}\nEND`);
  assert.ok(transition.endsWith('\nEND'));
});

it('invalid configuration fails synchronously with exact value-free diagnostics before any provider call', () => {
  const cases: [unknown, string][] = [
    ...[null, [], 'secret'].map(value => [value, 'configuration: expected object'] as [unknown, string]),
    ...['unregistered-preset', 'DEFAULT', 1, null].map(preset => [{ preset }, 'preset: unsupported preset'] as [unknown, string]),
    ...['', 1, null].map(participant => [{ participant }, 'participant: expected nonblank string'] as [unknown, string]),
    [{ typo: 'secret' }, 'configuration: unknown key'],
    [{ templates: {} }, 'templates: expected nonempty object'],
    [{ templates: [] }, 'templates: expected nonempty object'],
    [{ templates: { typo: 'secret' } }, 'templates: unknown key'],
    ...['', '  ', 42, null, {}, [], () => 'secret'].map(chunk => [{ templates: { chunk } }, 'templates.chunk: expected nonblank string'] as [unknown, string]),
    ...['{', '}', '{{participant}}'].map(chunk => [{ templates: { chunk } }, 'templates.chunk: malformed braces'] as [unknown, string]),
    ...['{targetToken}', '{unknown}', '{totalTokens}'].map(chunk => [{ templates: { chunk } }, 'templates.chunk: unsupported placeholder'] as [unknown, string]),
    [{ templates: { chunk: '{participant}' } }, 'participant: participant required'],
    [{ templates: { transition: 'no data' } }, 'templates.transition: context must appear once'],
    [{ templates: { transition: '{context}{context}' } }, 'templates.transition: context must appear once'],
    [{ templates: { opening: '{targetTokens}' } }, 'templates.opening: unsupported placeholder'],
  ];
  for (const [value, suffix] of cases) {
    for (const validate of [() => validateCompressionInstructions(value), () => new Probe({ compressionInstructions: value as never })]) {
      assert.throws(validate, { name: 'TypeError', message: `Invalid compressionInstructions configuration: ${suffix}` });
    }
  }
  validateCompressionInstructions(JSON.parse(JSON.stringify(custom)));
  assert.throws(() => new Probe({ witnessedInstruction: 'old', compressionInstructions: { templates: { witnessedChunk: 'new' } } }), { name: 'TypeError', message: 'Conflicting witnessedInstruction and compressionInstructions.templates.witnessedChunk; remove one setting' });
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
  assert.equal(instruction(calls[0]!), 'EXISTING 2000\n\nWITNESS-REMINDER');
});

it('templates alone need no preset; partial overrides leave every other phase at DEFAULT', async () => {
  const config: CompressionInstructions = { templates: { chunk: 'ONLY CHUNK {targetTokens}' } };
  assert.equal(instruction((await run('chunk', 'own', config))[0]!), 'ONLY CHUNK 2000');
  for (const [mode, pin] of [['chunk', 'inherited'], ['reading', 'own'], ['merge', 'own'],
    ['fallback', 'inherited'], ['readingFallback', 'own'], ['transition', 'own']] as const) {
    assert.equal(requestBytes(await run(mode, pin, config)), requestBytes(await run(mode, pin)));
  }
  const pieces = await run('readingSplit', 'mixed', config);
  assert.deepEqual(pieces.slice(2).map(instruction), [1000, 500, 500, 1000, 500, 500].map(n => `ONLY CHUNK ${n}`));
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
    assert.equal(requestBytes(await run('chunk', 'own', config)), requestBytes(await run('chunk', 'own')));
  }
});

it('only the registered default preset is accepted, including with complete templates', () => {
  validateCompressionInstructions({ preset: 'default' });
  validateCompressionInstructions({ ...custom, preset: 'default' });
  for (const preset of ['unregistered-preset', 'DEFAULT', '', '__proto__', 'constructor']) {
    for (const config of [{ preset }, { ...custom, preset, participant: 'Explicit actor' }]) {
      assert.throws(() => validateCompressionInstructions(config), {
        name: 'TypeError', message: 'Invalid compressionInstructions configuration: preset: unsupported preset',
      });
      assert.throws(() => new Probe({ compressionInstructions: config as never }), {
        name: 'TypeError', message: 'Invalid compressionInstructions configuration: preset: unsupported preset',
      });
    }
  }
});

it('participant is explicit and required only by custom placeholders, never inferred from summary ownership', () => {
  for (const slot of ['opening', 'chunk', 'witnessedChunk', 'readingChunk', 'merge', 'witnessedMerge', 'readingMerge', 'transition'] as const) {
    const template = slot === 'transition' ? '{participant} {context}' : '{participant}';
    assert.throws(() => new Probe({ summaryParticipant: 'Not an implicit actor',
      compressionInstructions: { templates: { [slot]: template } } }), {
      name: 'TypeError', message: 'Invalid compressionInstructions configuration: participant: participant required',
    });
    validateCompressionInstructions({ participant: 'Explicit actor', templates: { [slot]: template } });
  }
});

it('explicit default still permits custom overrides', async () => {
  assert.equal(requestBytes(await run('chunk', 'own', { ...custom, preset: 'default' })), requestBytes(await run('chunk', 'own', custom)));
});

for (const pin of ['own', 'mixed', 'inherited'] as const) {
  it(`reading retry/${pin}: partial merge settings ignore reading mode and preserve witnessed voice`, async () => {
    const config: CompressionInstructions = { templates: {
      merge: 'RETRY MERGE {sourceLevelShown}', witnessedMerge: 'RETRY WITNESS {sourceLevelShown}',
    } };
    const calls = await run('readingFallback', pin, config);
    assert.ok(!instruction(calls[0]!).startsWith('RETRY'));
    assert.equal(instruction(calls[1]!), `RETRY ${pin === 'inherited' ? 'WITNESS' : 'MERGE'} 1`);
  });
}

it('ordinary merge-only overrides do not own the separate source-level retry hook', async () => {
  class MergeOnly extends Probe {
    protected override getMergeInstruction() { return 'ORDINARY SUBCLASS'; }
  }
  for (const pin of ['own', 'inherited'] as const) {
    const defaults = await run('fallback', pin);
    const calls = await run('fallback', pin, undefined, {}, MergeOnly);
    assert.equal(instruction(calls[0]!), 'ORDINARY SUBCLASS');
    assert.equal(instruction(calls[1]!), instruction(defaults[1]!));
    const selected = await run('fallback', pin, custom, {}, MergeOnly);
    assert.equal(instruction(selected[0]!), 'ORDINARY SUBCLASS');
    assert.equal(instruction(selected[1]!), pin === 'inherited' ? 'CUSTOM WMERGE 1 2 2000' : 'CUSTOM MERGE 1 2 2000');
  }
});

for (const mode of ['fallback', 'readingFallback'] as const) {
  for (const pin of ['own', 'inherited'] as const) {
    it(`${mode}/${pin}: L3 retry shows L2 sources`, async () => {
      const calls = await run(mode, pin, custom, {}, Probe, 3);
      assert.equal(instruction(calls[0]!), mode === 'readingFallback' ? 'CUSTOM RMERGE 1 3 2560 2000' : pin === 'inherited' ? 'CUSTOM WMERGE 1 3 2000' : 'CUSTOM MERGE 1 3 2000');
      assert.equal(instruction(calls[1]!), pin === 'inherited' ? 'CUSTOM WMERGE 2 3 2000' : 'CUSTOM MERGE 2 3 2000');
    });
  }
}

it('validation diagnostics identify only allowlisted paths and reasons, never supplied data', () => {
  for (const [value, suffix] of [
    [{ privateKey: 'PRIVATE PAYLOAD' }, 'configuration: unknown key'],
    [{ preset: 'PRIVATE PAYLOAD' }, 'preset: unsupported preset'],
    [{ participant: ' ', templates: { chunk: 'PRIVATE PAYLOAD' } }, 'participant: expected nonblank string'],
    [{ templates: { privateKey: 'PRIVATE PAYLOAD' } }, 'templates: unknown key'],
    [{ templates: { chunk: 'PRIVATE PAYLOAD {privateKey}' } }, 'templates.chunk: unsupported placeholder'],
    [{ templates: { chunk: 'PRIVATE PAYLOAD {' } }, 'templates.chunk: malformed braces'],
    [{ templates: { transition: 'PRIVATE PAYLOAD' } }, 'templates.transition: context must appear once'],
    [{ templates: { chunk: '{participant}' } }, 'participant: participant required'],
  ] as const) {
    for (const validate of [() => validateCompressionInstructions(value), () => new Probe({ compressionInstructions: value as never })]) {
      assert.throws(validate, { name: 'TypeError', message: `Invalid compressionInstructions configuration: ${suffix}` });
    }
  }
});

it('rendering ignores inherited slots and the stored clone is validated after getters run', () => {
  const templates = Object.create({ opening: 'INHERITED' });
  assert.equal(compressionInstruction({ templates }, 'opening', {}), undefined);
  let reads = 0;
  const config = { templates: { get opening() { return ++reads === 1 ? 'valid' : '{unknown}'; } } };
  assert.throws(() => new Probe({ compressionInstructions: config }), {
    name: 'TypeError', message: 'Invalid compressionInstructions configuration: templates.opening: unsupported placeholder',
  });
  class Expose extends Probe { opening() { return this.getCompressionOpening(); } }
  let snapshotReads = 0;
  const changing = { templates: { get opening() { return ++snapshotReads <= 3 ? 'validated snapshot' : '{unknown}'; } } };
  const snapshot = new Expose({ compressionInstructions: changing });
  assert.equal(snapshot.opening(), 'validated snapshot');
  assert.equal(snapshotReads, 3, 'caller and resolved validation, then clone; stored validation reads no getters');
});

it('source-retry subclasses receive only level, sources and target tokens, including reading retries', async () => {
  const received: unknown[][] = [];
  class SourceArgs extends Probe {
    protected override getSourceMergeInstruction(targetLevel: SummaryLevel, sources: SummaryEntry[], targetTokens: number) {
      received.push(Array.from(arguments));
      return super.getSourceMergeInstruction(targetLevel, sources, targetTokens);
    }
  }
  for (const mode of ['fallback', 'readingFallback'] as const) {
    received.length = 0;
    const calls = await run(mode, 'mixed', undefined, {}, SourceArgs);
    assert.equal(received.length, 1);
    assert.equal(received.at(-1)!.length, 3);
    assert.equal(received.at(-1)![0], 2);
    assert.equal((received.at(-1)![1] as unknown[]).length, 2);
    assert.equal(received.at(-1)![2], 2000);
    assert.ok(calls.length === 2);
  }
});

it('inherited options are ignored and enforced invalid settings have value-free errors', () => {
  new Probe(Object.create({ compressionInstructions: null }));
  class Enforced extends Probe {
    protected override enforcedConfigLayer() {
      return { source: 'test', values: { compressionInstructions: { templates: { chunk: () => 'PRIVATE' } } } };
    }
  }
  assert.throws(() => new Enforced(), {
    name: 'TypeError', message: 'Invalid compressionInstructions configuration: templates.chunk: expected nonblank string',
  });
  let reads = 0;
  const changing = { templates: { get opening() { return ++reads < 3 ? 'valid' : () => 'PRIVATE'; } } };
  assert.throws(() => new Probe({ compressionInstructions: changing as never }), {
    name: 'TypeError', message: 'Invalid compressionInstructions configuration: configuration: settings must be cloneable',
  });
  assert.throws(() => new Probe({ witnessedInstruction: '', compressionInstructions: {
    templates: { witnessedChunk: 'custom' },
  } }), /Conflicting witnessedInstruction and compressionInstructions.templates.witnessedChunk; remove one setting/);
});

it('source-only custom merges retain the attribution discipline suffix', async () => {
  for (const pin of ['own', 'inherited'] as const) {
    const calls = await run('merge', pin, custom, { compressionMergeSourceOnly: true });
    assert.equal(instruction(calls[0]!), `CUSTOM ${pin === 'inherited' ? 'WMERGE' : 'MERGE'} 0 2 2000\n\nAttribution discipline: preserve who made each claim. Do not turn another participant’s diagnosis, promise, operational status, or forecast into your own first-person fact unless the source includes your own direct confirmation. Preserve corrections and uncertainty explicitly.`);
  }
});

it('witnessedInstruction is retained by witnessed split pieces', async () => {
  for (const mode of ['split', 'readingSplit'] as const) {
    const calls = await run(mode, 'inherited', { templates: { chunk: 'UNUSED' } },
      { witnessedInstruction: 'EXISTING {targetTokens}' });
    for (const [index, call] of calls.slice(2).entries()) {
      assert.equal(instruction(call), `EXISTING ${[1000, 500, 500, 1000, 500, 500][index]}`);
    }
  }
});

it('non-refusal tool-use reading merge retries retain reading template and no-tools addition', async () => {
  const calls = await run('readingFallback', 'own', custom, {}, Probe, 2, 'tool_use');
  assert.equal(instruction(calls[0]!), 'CUSTOM RMERGE 0 2 2560 2000');
  assert.equal(instruction(calls[1]!), instruction(calls[0]!) + '\n\nWrite the memory as plain text directly in your response — do not call any tools for this.');
  assert.ok(instruction(calls[1]!).includes('Write the memory as plain text directly in your response — do not call any tools for this.'));
});

it('empty chunk retries retain custom text and request plain prose', async () => {
  const calls = await run('chunk', 'own', custom, {}, Probe, 2, 'empty');
  assert.equal(instruction(calls[0]!), 'CUSTOM CHUNK 2000');
  assert.ok(instruction(calls[1]!).startsWith(instruction(calls[0]!)));
  assert.match(instruction(calls[1]!), /plain prose/);
});

it('rejects own symbols and non-enumerable settings rather than dropping them at clone time', () => {
  for (const [key, enumerable] of [['chunk', false], [Symbol('private'), false], [Symbol('private'), true]] as const) {
    const templates = Object.defineProperty({ opening: 'valid' }, key, { value: 'hidden', enumerable });
    for (const value of [{ templates }, Object.defineProperty({}, key, { value: 'hidden', enumerable })]) {
      assert.throws(() => validateCompressionInstructions(value), (error: unknown) => error instanceof TypeError && /expected enumerable string keys/.test(error.message) && !/hidden|private/.test(error.message));
      assert.throws(() => new Probe({ compressionInstructions: value }), (error: unknown) => error instanceof TypeError && /expected enumerable string keys/.test(error.message) && !/hidden|private/.test(error.message));
    }
  }
});

it('validates cloneable invalid text returned only at clone time', () => {
  let reads = 0;
  const config = { templates: { get opening() { return ++reads < 3 ? 'valid' : '{unknown}'; } } };
  assert.throws(() => new Probe({ compressionInstructions: config }), {
    name: 'TypeError', message: 'Invalid compressionInstructions configuration: templates.opening: unsupported placeholder',
  });
  assert.equal(reads, 3);
});

it('ordinary, witnessed and reading merge templates infer the declared shown level', () => {
  class Expose extends Probe {
    check(witnessed: boolean) {
      const sources = [{ level: 2, sourceLevel: 0, witnessed }] as SummaryEntry[];
      assert.equal(this.getMergeInstruction(3, sources, 100), `CUSTOM ${witnessed ? 'W' : ''}MERGE 0 3 100`);
      assert.equal(this.getReadingMergeInstruction(3, sources, 500, 100), 'CUSTOM RMERGE 0 3 500 100');
    }
  }
  const probe = new Expose({ compressionInstructions: custom });
  probe.check(false);
  probe.check(true);
});

it('delegating legacy hooks infer the declared child level for custom templates', () => {
  class Legacy extends Probe {
    check(sourceLevel: 0 | 1) {
      const sources = [{ level: 3, sourceLevel }] as SummaryEntry[];
      assert.equal(super.getMergeInstruction(4, sources, 100), `CUSTOM MERGE ${sourceLevel} 4 100`);
      assert.equal(super.getReadingMergeInstruction(4, sources, 500, 100), `CUSTOM RMERGE ${sourceLevel} 4 500 100`);
    }
  }
  const probe = new Legacy({ compressionInstructions: custom });
  probe.check(0);
  probe.check(1);
});

it('L4 merges of legacy L3 sources that skip a level show their L1 children', async () => {
  for (const mode of ['merge', 'readingMerge'] as const) {
    const calls = await run(mode, 'own', custom, {}, Probe, 4);
    assert.match(instruction(calls[0]!), mode === 'merge' ? /^CUSTOM MERGE 1 4 / : /^CUSTOM RMERGE 1 4 /);
    assert.ok(texts(calls[0]!).some(text => text === '[CM] Recall memory L1-100.'));
  }
});

for (const mode of ['merge', 'readingMerge'] as const) {
  it(`${mode}: legacy optional numeric modes keep their defaults and call arities`, async () => {
    class Legacy extends Probe {
      protected override getMergeInstruction(
        level: SummaryLevel, sources: SummaryEntry[], tokens: number, mode = 7,
      ) {
        assert.equal(arguments.length, 3);
        return `LEGACY MERGE ${mode}`;
      }
      protected override getReadingMergeInstruction(
        level: SummaryLevel, sources: SummaryEntry[], total: number, tokens: number, mode = 7,
      ) {
        assert.equal(arguments.length, 4);
        return `LEGACY READING ${mode}`;
      }
    }
    for (const config of [undefined, {}, { preset: 'default' }, custom] as (CompressionInstructions | undefined)[]) {
      const calls = await run(mode, 'own', config, {}, Legacy);
      assert.equal(instruction(calls[0]!), `LEGACY ${mode === 'merge' ? 'MERGE' : 'READING'} 7`);
    }
  });
}

it('legacy optional boolean modes remain type-compatible and delegate with the old call shape', async () => {
  class Legacy extends Probe {
    protected override getMergeInstruction(
      level: SummaryLevel, sources: SummaryEntry[], tokens: number, mode = true,
    ) {
      assert.equal(mode, true);
      assert.equal(arguments.length, 3);
      return super.getMergeInstruction(level, sources, tokens);
    }
    protected override getReadingMergeInstruction(
      level: SummaryLevel, sources: SummaryEntry[], total: number, tokens: number, mode = true,
    ) {
      assert.equal(mode, true);
      assert.equal(arguments.length, 4);
      return super.getReadingMergeInstruction(level, sources, total, tokens);
    }
  }
  for (const mode of ['merge', 'readingMerge'] as const) {
    for (const config of [undefined, {}, { preset: 'default' }, custom] as (CompressionInstructions | undefined)[]) {
      assert.equal(requestBytes(await run(mode, 'own', config, {}, Legacy)), requestBytes(await run(mode, 'own', config)));
    }
  }
});

it('inherited instruction fields cannot select wording or supply the explicit participant', () => {
  const fields = { templates: { chunk: 'UNEXPECTED', witnessedChunk: 'UNEXPECTED' }, participant: 'INHERITED', preset: 'unknown' };
  const saved = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
    validateCompressionInstructions({});
    assert.equal(compressionInstruction({}, 'chunk', { targetTokens: 100 }), undefined);
    new Probe({ witnessedInstruction: 'existing', compressionInstructions: {} });
    assert.throws(() => validateCompressionInstructions({ templates: { chunk: '{participant}' } }), /participant required/);
    assert.throws(() => new Probe({ compressionInstructions: { templates: { chunk: '{participant}' } } }), /participant required/);
  } finally {
    for (const key of Object.keys(fields)) {
      if (Object.hasOwn(saved, key)) Object.defineProperty(Object.prototype, key, saved[key]);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
});

it('throwing getters and proxies produce value-free TypeErrors in validator and constructor', () => {
  const fail = () => { throw new Error('PRIVATE TEMPLATE DATA'); };
  for (const value of [
    { get preset() { return fail(); } },
    { templates: { get chunk() { return fail(); } } },
    new Proxy({}, { getPrototypeOf: fail }),
    new Proxy({}, { ownKeys: fail }),
  ]) {
    for (const check of [() => validateCompressionInstructions(value), () => new Probe({ compressionInstructions: value })]) {
      assert.throws(check, { name: 'TypeError', message: 'Invalid compressionInstructions configuration: configuration: unable to inspect settings' });
    }
  }
});

it('ordinary and reading merge hooks retain fallback levels for empty and legacy sources', () => {
  class Expose extends Probe {
    check() {
      for (const [sources, shown] of [[[], 0], [[{ level: 3 }], 2], [[{ level: 3, witnessed: true }], 2]] as [SummaryEntry[], number][]) {
        assert.equal(this.getMergeInstruction(4, sources, 100), `CUSTOM ${sources[0]?.witnessed ? 'W' : ''}MERGE ${shown} 4 100`);
        assert.equal(this.getReadingMergeInstruction(4, sources, 500, 100), `CUSTOM RMERGE ${shown} 4 500 100`);
      }
    }
  }
  new Expose({ compressionInstructions: custom }).check();
});

it('skipped-level L4 telemetry retains the legacy shown level across defaults and retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-level-'));
  const log = join(dir, 'calls.jsonl');
  const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
  try {
    const expected: number[] = [];
    for (const config of [undefined, {}, { preset: 'default' }, custom] as (CompressionInstructions | undefined)[]) {
      for (const childLevel of [0, 1] as const) {
        for (const mode of ['merge', 'readingMerge', 'fallback', 'readingFallback'] as const) {
          const calls = await run(mode, 'own', config, {}, Probe, 4, undefined, childLevel);
          expected.push(...calls.map(() => childLevel === 0 ? 0 : 2));
          if (config === custom) assert.match(instruction(calls[0]!), new RegExp(`^CUSTOM R?MERGE ${childLevel} 4 `));
        }
      }
    }
    const records = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(record => record.operation === 'merge_l4' && !record.event);
    assert.deepEqual(records.map(record => record.metadata.source_level_shown), expected);
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});


it('a recall-shaped custom opening does not split consecutive source turns', async () => {
  class SameSpeaker extends Probe {
    override compress(chunk: Parameters<Probe['compress']>[0], ctx: Parameters<Probe['compress']>[1]) {
      return super.compress({ ...chunk, messages: chunk.messages.map(m => ({ ...m, participant: 'Participant' })) }, ctx);
    }
  }
  for (const mode of ['chunk', 'split'] as const) {
    const baseline = await run(mode, 'own', undefined, {}, SameSpeaker);
    const opening = '[CM] Recall memory example.';
    const calls = await run(mode, 'own', { templates: { opening } }, {}, SameSpeaker);
    assert.equal(calls.length, baseline.length);
    for (const [i, request] of calls.entries()) {
      assert.ok(texts(request).includes(opening), 'configured opening reached the real request');
      assert.ok(!texts(request).includes('[CM] The conversation resumes.'));
      const originalOpening = baseline[i]!.messages.find(m => m.participant === 'Context Manager')!.content;
      const restored = structuredClone(request);
      restored.messages.find(m => m.participant === 'Context Manager')!.content = originalOpening;
      assert.deepEqual(restored, baseline[i], 'only the opening changes; source turns still collapse identically');
    }
  }
});

it('default L1 keeps recall-shaped raw source turns together without a resume separator', async () => {
  class RawRecall extends Probe {
    override compress(chunk: Parameters<Probe['compress']>[0], ctx: Parameters<Probe['compress']>[1]) {
      return super.compress({ ...chunk, messages: chunk.messages.map((m, i) => ({ ...m,
        participant: i === 0 ? 'Context Manager' : 'Participant',
        content: i === 0 ? [{ type: 'text', text: '[CM] Recall memory raw.' }] : m.content,
      })) }, ctx);
    }
  }
  const [request] = await run('chunk', 'own', undefined, {}, RawRecall);
  assert.ok(texts(request!).includes('[CM] Recall memory raw.'));
  assert.ok(!texts(request!).includes('[CM] The conversation resumes.'));
  const source = request!.messages.find(m => m.participant === 'Participant')!;
  assert.equal(source.content.filter(b => b.type === 'text' && b.text.startsWith('raw-')).length, 3);
});

it('outer instruction accessors are read once and failures are value-free', () => {
  assert.throws(() => new Probe({ get compressionInstructions(): CompressionInstructions { throw new Error('PRIVATE'); } }), {
    name: 'TypeError', message: 'Invalid compressionInstructions configuration: configuration: unable to inspect settings',
  });
  let reads = 0;
  new Probe({ get compressionInstructions() {
    if (++reads > 1) throw new Error('PRIVATE LATER');
    return { templates: { opening: 'OPEN' } };
  } });
  assert.equal(reads, 1);
});

it('clone failures identify cloneability and hidden-only template keys identify key shape', () => {
  const proxy = new Proxy({}, {});
  validateCompressionInstructions(proxy); // Structural validation does not promise cloneability.
  assert.throws(() => new Probe({ compressionInstructions: proxy }), /settings must be cloneable/);
  for (const key of ['chunk', Symbol('hidden')]) {
    assert.throws(() => validateCompressionInstructions({ templates: Object.defineProperty({}, key, { value: 'hidden' }) }), (error: unknown) => error instanceof TypeError && /expected enumerable string keys/.test(error.message) && !/hidden|private/.test(error.message));
  }
});

it('KnowledgeStrategy phase-specific overrides retain their wording with custom templates', async () => {
  for (const phaseType of ['research', 'synthesis', 'lesson', 'subagent'] as const) {
    class PhaseKnowledge extends KnowledgeProbe {
      override compress(chunk: Parameters<Probe['compress']>[0], ctx: Parameters<Probe['compress']>[1]) {
        return super.compress({ ...chunk, phaseType }, ctx);
      }
    }
    const [baseline] = await run('chunk', 'own', undefined, {}, PhaseKnowledge);
    const [configured] = await run('chunk', 'own', custom, {}, PhaseKnowledge);
    assert.equal(instruction(configured!), instruction(baseline!));
    assert.ok(instruction(configured!).includes('[LEAD]'));
    assert.ok(!instruction(configured!).includes('CUSTOM CHUNK'));
    assert.ok(texts(configured!).includes('CUSTOM OPEN'));
  }
});

it('option accessors retain their original receiver and inherited state', () => {
  const options = Object.create({ limit: 1234 });
  Object.defineProperties(options, {
    recentWindowTokens: { enumerable: true, get() { assert.equal(this, options); return this.limit; } },
    compressionInstructions: { enumerable: true, value: {} },
  });
  class Inspect extends Probe { window() { return this.config.recentWindowTokens; } }
  assert.equal(new Inspect(options).window(), 1234);
});

it('JSON __proto__ cannot inject inherited compression settings', () => {
  const options = JSON.parse('{"__proto__":{"compressionInstructions":{"templates":{"chunk":"Injected"}}}}');
  class Inspect extends Probe { settings() { return this.config.compressionInstructions; } }
  assert.equal(new Inspect(options).settings(), undefined);
  for (const semantics of ['spread-fidelity', 'skip-nullish'] as const) {
    const { effective, provenance } = resolveEffectiveConfig([{ source: 'caller', values: options }], semantics);
    assert.equal(Object.getPrototypeOf(effective), Object.prototype);
    assert.equal(Object.getPrototypeOf(provenance), Object.prototype);
    assert.ok(Object.hasOwn(effective, '__proto__'));
    assert.ok(Object.hasOwn(provenance, '__proto__'));
    assert.deepEqual(effective['__proto__'], options['__proto__']);
    assert.equal(provenance['__proto__'], 'caller');
  }
});

it('absent instruction settings never probe an absent descriptor', () => {
  const options = new Proxy({ recentWindowTokens: 1234 }, {
    getOwnPropertyDescriptor(target, key) {
      if (!Reflect.has(target, key)) throw new Error('absent descriptor');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  for (const Strategy of [Probe, KnowledgeProbe]) assert.doesNotThrow(() => new Strategy(options));
});

it('proxy get traps on other options retain their values with instruction settings', () => {
  const options = new Proxy({ compressionInstructions: {}, recentWindowTokens: 1 }, {
    get(target, key, receiver) { return key === 'recentWindowTokens' ? 1234 : Reflect.get(target, key, receiver); },
  });
  class Inspect extends Probe { window() { return this.config.recentWindowTokens; } }
  class KnowledgeInspect extends KnowledgeProbe { window() { return this.config.recentWindowTokens; } }
  for (const Strategy of [Inspect, KnowledgeInspect]) assert.equal(new Strategy(options).window(), 1234);
});

it('only instruction-specific inspection failures are reported as invalid instructions', () => {
  const failure = new Error('outer options failure');
  assert.throws(() => new Probe(new Proxy({}, { ownKeys() { throw failure; } })), error => error === failure);
  assert.throws(() => new Probe(null as never), error => error instanceof TypeError && !error.message.includes('compressionInstructions'));
  assert.throws(() => new Probe(new Proxy({ compressionInstructions: {}, other: true }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'other') throw failure;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  })), error => error === failure);
  assert.throws(() => new Probe(new Proxy({ compressionInstructions: {} }, {
    getOwnPropertyDescriptor() { throw failure; },
  })), { name: 'TypeError', message: 'Invalid compressionInstructions configuration: configuration: unable to inspect settings' });
});

it('KnowledgeStrategy snapshots the outer instruction getter only once', () => {
  let reads = 0;
  const options = { get compressionInstructions() {
    if (++reads > 1) throw new Error('sensitive second read');
    return { preset: 'default' as const };
  } };
  assert.doesNotThrow(() => new KnowledgeProbe(options));
  assert.equal(reads, 1);
});

it('repeated instruction descriptor failures are sanitized', () => {
  let reads = 0;
  const options = new Proxy({ compressionInstructions: {} }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'compressionInstructions' && ++reads === 2) throw new Error('sensitive descriptor');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => new Probe(options), error => error instanceof TypeError
    && error.message.includes('unable to inspect settings') && !error.message.includes('sensitive'));
});

it('instruction settings and templates reject custom prototypes and accept null prototypes', () => {
  for (const value of [Object.create({}), { templates: Object.create({}) }]) {
    assert.throws(() => validateCompressionInstructions(value), TypeError);
    assert.throws(() => new Probe({ compressionInstructions: value }), TypeError);
  }
  for (const value of [Object.create(null), { templates: Object.assign(Object.create(null), { opening: 'OPEN' }) }]) {
    validateCompressionInstructions(value);
    assert.doesNotThrow(() => new Probe({ compressionInstructions: value }));
  }
});

it('unrelated symbol descriptors are not inspected and primitive JS options retain defaults', () => {
  const symbol = Symbol('unrelated');
  const config = new Proxy({ compressionInstructions: {}, [symbol]: true }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === symbol) throw new Error('symbol descriptor inspected');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.doesNotThrow(() => new Probe(config));
  for (const value of [false, 1]) {
    assert.doesNotThrow(() => new Probe(value as never));
    assert.doesNotThrow(() => new KnowledgeProbe(value as never));
  }
});

it('inherited instruction options cannot supply templates or create conflicts', () => {
  const keys = ['compressionInstructions', 'witnessedInstruction'] as const;
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(Object.prototype, key));
  try {
    Object.defineProperty(Object.prototype, 'compressionInstructions', { configurable: true,
      value: { templates: { opening: 'polluted' } } });
    Object.defineProperty(Object.prototype, 'witnessedInstruction', { configurable: true, value: 'polluted' });
    new Probe({ compressionInstructions: { templates: { witnessedChunk: 'explicit' } } });
    class OpeningProbe extends Probe { opening() { return this.getCompressionOpening(); } }
    assert.notEqual(new OpeningProbe().opening(), 'polluted');
  } finally {
    keys.forEach((key, index) => {
      if (descriptors[index]) Object.defineProperty(Object.prototype, key, descriptors[index]!);
      else Reflect.deleteProperty(Object.prototype, key);
    });
  }
});

it('public preview overrides retain absent instruction shadows', async () => {
  const { ContextManager } = await import('../src/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'ip-'));
  const keys = ['compressionInstructions', 'witnessedInstruction'] as const;
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(Object.prototype, key));
  class PreviewProbe extends Probe {
    checked = false;
    override select(...args: Parameters<Probe['select']>) {
      assert.equal(this.config.compressionInstructions, undefined);
      assert.equal(this.config.witnessedInstruction, undefined);
      this.checked = true;
      return super.select(...args);
    }
  }
  const strategy = new PreviewProbe();
  const manager = await ContextManager.open({ path: dir, strategy });
  try {
    for (const key of keys) Object.defineProperty(Object.prototype, key, {
      value: key === 'compressionInstructions' ? { templates: { opening: 'polluted' } } : 'polluted',
      configurable: true,
    });
    manager.previewContext({ maxTokens: 10000, reserveForResponse: 0 }, { headWindowTokens: 1 });
    assert.equal(strategy.checked, true);
  } finally {
    keys.forEach((key, index) => {
      if (descriptors[index]) Object.defineProperty(Object.prototype, key, descriptors[index]!);
      else Reflect.deleteProperty(Object.prototype, key);
    });
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
