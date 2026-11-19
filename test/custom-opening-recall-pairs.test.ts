// A custom opening begins the chunk's own messages. The recall-curve variants
// and the cache seams find recall pairs by their text, so with a custom
// opening they read pairs only before it: neither a header-shaped opening nor
// a source turn quoting a recall answer is read as a pair. Witnesses from the
// CM486 R3 review (curve.mjs, curve-prefix.mjs, probe.mjs) and the
// templates-b review (boundary-control.mjs, probe), through the
// public ContextManager.open -> tick -> membrane.complete path on a reopened
// store.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { CompressionInstructions } from '../src/index.js';

type Shape = {
  refuseFirst: boolean; withParent: boolean; cmPrefix: boolean; firstSource: string;
  /** A raw Context Manager turn between the compressed and the target chunk. */
  boundary?: string;
  /** Participant of the first target turn (default Other). */
  firstSourceParticipant?: string;
};

async function mint(shape: Shape, compressionInstructions?: CompressionInstructions): Promise<NormalizedRequest[]> {
  const path = mkdtempSync(join(tmpdir(), 'cm-opening-pairs-'));
  const calls: NormalizedRequest[] = [];
  const strategy = () => new AutobiographicalStrategy({
    compressionSourceOnlyFallback: false,
    compressionRefusalCurveFallbacks: 1,
    compressionModel: 'mock',
    headWindowTokens: 0,
    recentWindowTokens: 0,
    targetChunkTokens: 100,
    minChunkCharsForLLM: 0,
    l1HoldbackChunks: 0,
    mergeThreshold: 99,
    autoTickOnNewMessage: false,
    ...(compressionInstructions === undefined ? {} : { compressionInstructions }),
  });
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      if (shape.refuseFirst && calls.length === 1) {
        return { stopReason: 'refusal', content: [], usage: { inputTokens: 200, outputTokens: 0 } };
      }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'mock summary of events' }], usage: { inputTokens: 200, outputTokens: 12 } };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const open = () => ContextManager.open({ path, strategy: strategy(), membrane: membrane as any });
  let manager = await open();
  try {
    const add = (participant: string, text: string) => manager.addMessage(participant, [{ type: 'text', text }]);
    if (shape.cmPrefix) add('Context Manager', 'prefix CM');
    const prior = add('P', 'prior '.repeat(60));
    if (shape.boundary !== undefined) add('Context Manager', shape.boundary);
    const ids = [
      add(shape.firstSourceParticipant ?? 'Other', shape.firstSource),
      add('Context Manager', '[CM] Recall memory raw.'),
      add('P', 'beta '.repeat(50)),
      add('P', 'gamma '.repeat(50)),
    ];
    add('Other', 'later '.repeat(100));
    const child = {
      id: 'L1-100', level: 1, sourceLevel: 0, content: 'PRIOR SUMMARY', sourceIds: [prior],
      sourceRange: { first: prior, last: prior }, tokens: 10, created: 1,
    } as Record<string, unknown>;
    const summaries: Array<Record<string, unknown>> = [child];
    if (shape.withParent) {
      summaries.push({ ...child, id: 'L2-101', sourceIds: ['L1-100'], level: 2, sourceLevel: 1, content: 'PARENT SUMMARY' });
      child.mergedInto = 'L2-101';
    }
    manager.getStore().setStateJson('default/autobio:summaries', summaries);
    manager.getStore().setStateJson('default/autobio:chunks', [
      { id: 'c0', compressed: true, sourceIds: [prior], summaryId: 'L1-100' },
      { id: 'c1', compressed: false, sourceIds: ids },
    ]);
    manager.close();
    manager = await open();
    await manager.tick();
    assert.ok(calls.length > 0, 'the chunk was sent');
    return calls;
  } finally {
    manager.close();
    rmSync(path, { recursive: true, force: true });
  }
}

const firstText = (m: NormalizedRequest['messages'][number]) =>
  (m.content[0] as { text?: string } | undefined)?.text ?? '';
const textsOf = (r: NormalizedRequest) => r.messages.map(firstText);

it('a header-shaped custom opening does not stop the recall-curve retry', async () => {
  // The opening names the recalled L2 and the first source turn quotes its
  // answer: read through the whole request that is a second match, and the
  // L2 -> L1 expansion was skipped (quarantine instead of a retry).
  const shape = { refuseFirst: true, withParent: true, cmPrefix: false, firstSource: 'PARENT SUMMARY' };
  for (const opening of ['OTHER', '[CM] Recall memory L2-101.']) {
    const calls = await mint(shape, { templates: { opening } });
    assert.equal(calls.length, 2, `${opening}: canonical refusal, then the L1 expansion`);
    const retry = textsOf(calls[1]!);
    assert.deepEqual(retry.slice(0, 4), ['[CM] Recall memory L1-100.', 'PRIOR SUMMARY', opening, 'PARENT SUMMARY'],
      `${opening}: the genuine pair is expanded; the opening and the quoting source turn stay`);
  }
});

it('a custom opening and a quoting source turn are never replaced as a recall pair', async () => {
  // A raw Context Manager turn before the genuine header coalesces with it,
  // so the genuine pair can't be matched. Read through the whole request,
  // the opening and the first source turn were then the only match, and the
  // retry replaced them with the child's header and answer.
  const shape = { refuseFirst: true, withParent: true, cmPrefix: true, firstSource: 'PARENT SUMMARY' };
  for (const opening of ['OTHER', '[CM] Recall memory L2-101.']) {
    const calls = await mint(shape, { templates: { opening } });
    assert.equal(calls.length, 1, `${opening}: no variant is built; the chunk is quarantined as with an ordinary opening`);
    for (const request of calls) {
      const texts = textsOf(request);
      assert.ok(!texts.includes('PRIOR SUMMARY'), `${opening}: the child's answer never replaces source`);
      const at = texts.indexOf(opening);
      assert.ok(at > 0 && texts[at + 1] === 'PARENT SUMMARY', `${opening}: the opening and the raw source go as they are`);
    }
  }
});

it('a header-shaped custom opening does not move the frontier cache seam', async () => {
  const shape = { refuseFirst: false, withParent: false, cmPrefix: false, firstSource: 'alpha '.repeat(50) };
  const marked = (r: NormalizedRequest) => r.messages.filter(m => m.cacheBreakpoint).map(firstText);
  const control = await mint(shape, { templates: { opening: 'OTHER' } });
  assert.deepEqual(marked(control[0]!), ['PRIOR SUMMARY'], 'control: the prior answer carries the frontier seam');
  const colliding = await mint(shape, { templates: { opening: '[CM] Recall memory L1-100.' } });
  assert.deepEqual(marked(colliding[0]!), ['PRIOR SUMMARY'], 'an opening naming the ladder entry leaves the seam on the prior answer');
  assert.equal(colliding[0]!.cacheTtl, control[0]!.cacheTtl);
});

const BUILT_IN_OPENING =
  'System: You will soon form a new memory, get ready. ' +
  'The messages that follow are the slice of recent experience you are ' +
  'about to compress. After them, write the memory in your own voice.';
const RESUME = '[CM] The conversation resumes.';
/** Every text block of the first request, in order, separators dropped. */
const blocksOf = (r: NormalizedRequest) => r.messages.flatMap(m => m.content)
  .map(b => (b as { text?: string }).text ?? '').filter(t => t !== '\n\n---\n\n');

it('a custom opening after a raw header-shaped turn is not read as its answer', async () => {
  // The raw turn before the chunk looks like a recall header and the opening
  // follows it: read as that header's answer, the opening got the resume
  // turn before the Context Manager's first target turn.
  const shape = {
    refuseFirst: false, withParent: false, cmPrefix: false,
    boundary: '[CM] Recall memory boundary.', firstSource: 'TARGET', firstSourceParticipant: 'Context Manager',
  };
  for (const opening of ['[CM] Recall memory OPEN.', 'OTHER']) {
    const blocks = blocksOf((await mint(shape, { templates: { opening } }))[0]!);
    const at = blocks.indexOf(opening);
    assert.deepEqual(blocks.slice(at - 1, at + 2), ['[CM] Recall memory boundary.', opening, 'TARGET'],
      `${opening}: no resume turn between the opening and the first target turn`);
  }
  // The built-in opening is read as it always was.
  const base = blocksOf((await mint(shape))[0]!);
  const at = base.indexOf(BUILT_IN_OPENING);
  assert.deepEqual(base.slice(at - 1, at + 3), ['[CM] Recall memory boundary.', BUILT_IN_OPENING, RESUME, 'TARGET'],
    'default: unchanged');
});

it('an explicitly configured opening equal to the built-in marker counts as custom', async () => {
  // The target holds a raw header-shaped turn followed by a P turn and
  // another P turn. Read as a pair, it gets a resume turn; with the opening
  // slot present it is source, whatever the slot's text.
  const shape = { refuseFirst: false, withParent: false, cmPrefix: false, firstSource: 'alpha '.repeat(50) };
  const base = blocksOf((await mint(shape))[0]!);
  assert.ok(base.includes(RESUME), 'default: the raw header-shaped turn is read as a pair, as on main');
  for (const config of [{}, { preset: 'default' as const }, { templates: { chunk: 'Write it in {targetTokens}.' } }]) {
    const blocks = blocksOf((await mint(shape, config))[0]!);
    assert.equal(blocks.includes(RESUME), true, `${JSON.stringify(config)}: no opening slot, read as default`);
  }
  for (const opening of [BUILT_IN_OPENING, 'OTHER']) {
    const blocks = blocksOf((await mint(shape, { templates: { opening } }))[0]!);
    assert.ok(blocks.includes(opening));
    assert.ok(!blocks.includes(RESUME), `${opening.slice(0, 20)}: no resume turn after the raw target header`);
  }
});
