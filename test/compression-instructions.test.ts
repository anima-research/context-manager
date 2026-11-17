import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompressionInstructions } from '../src/index.js';
import { compressionInstruction } from '../src/compression-instructions.js';
import type { CompressionInstructions, SummaryLevel, SummaryEntry } from '../src/index.js';
import { Probe, run, custom, instruction, texts } from './compression-instructions-harness.js';

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
        else if (mode === 'readingMerge' || (mode === 'readingFallback' && index === 0)) {
          assert.match(s, new RegExp(`^CUSTOM RMERGE ${shown} 2 \\d+ \\d+$`));
        } else if (mode === 'merge' || mode === 'fallback' || mode === 'readingFallback') {
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
    assert.match(instruction((await run(mode, 'inherited', config)).at(-1)!), mode === 'readingMerge' ? /^RMERGE 0 2 \d+ \d+$/ : /^WMERGE 1 2 \d+$/);
  }
  const transition = instruction((await run('transition', 'own', config))[0]!);
  assert.match(transition, /^TRANSITION 1500\nDATA /);
  assert.match(transition, /raw-0 \{participant\} \{targetTokens\} \$&/);
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
  assert.throws(() => new Probe({ witnessedInstruction: 'old', compressionInstructions: { templates: { witnessedChunk: 'new' } } }), { name: 'TypeError', message: 'Conflicting witnessed instruction configuration' });
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
  assert.deepEqual(await run('chunk', 'own', { ...custom, preset: 'default' }), await run('chunk', 'own', custom));
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
    assert.match(instruction(selected[1]!), pin === 'inherited' ? /^CUSTOM WMERGE 1 2 / : /^CUSTOM MERGE 1 2 /);
  }
});

for (const mode of ['fallback', 'readingFallback'] as const) {
  for (const pin of ['own', 'inherited'] as const) {
    it(`${mode}/${pin}: L3 retry shows L2 sources`, async () => {
      const calls = await run(mode, pin, custom, {}, Probe, 3);
      assert.match(instruction(calls[1]!), pin === 'inherited' ? /^CUSTOM WMERGE 2 3 / : /^CUSTOM MERGE 2 3 /);
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
  const changing = { templates: { get opening() { return ++snapshotReads <= 2 ? 'validated snapshot' : '{unknown}'; } } };
  const snapshot = new Expose({ compressionInstructions: changing });
  assert.equal(snapshot.opening(), 'validated snapshot');
  assert.equal(snapshotReads, 2, 'one caller validation, one clone; validate the stored clone without reading getters again');
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
    const calls = await run(mode, 'mixed', undefined, {}, SourceArgs);
    assert.equal(received.at(-1)!.length, 3);
    assert.equal(received.at(-1)![0], 2);
    assert.equal((received.at(-1)![1] as unknown[]).length, 2);
    assert.equal(typeof received.at(-1)![2], 'number');
    assert.ok(calls.length === 2);
  }
});
