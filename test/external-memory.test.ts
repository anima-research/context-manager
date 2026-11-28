/**
 * external-memory: installing or editing a memory whose text was written
 * outside the strategy's own compression calls.
 *
 * The tree's shape stays the strategy's. An import is accepted only for work
 * the strategy would do itself now, and its text enters where a provider's
 * answer would, so the summary is written as a native one is. An edit keeps
 * lineage, and leaves the summaries merged over the old text alone. Neither
 * adds anything a compile renders besides the text.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { JsStore } from '@animalabs/chronicle';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { MemoryWorkItem, SummaryEntry } from '../src/types/index.js';
import { main } from '../scripts/external-memory-main.js';
import { residentStrategyOptions } from '../scripts/resident-settings.js';

const dir = mkdtempSync(join(tmpdir(), 'external-memory-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const NS = 'agents/Ada';
const MODEL = 'same-model';
const RECIPE = join(dir, 'recipe.json');
// The resident's settings, which the store doesn't hold: the tool reads them from its recipe.
const RECIPE_STRATEGY = {
  mergeThreshold: 3, headWindowTokens: 0, recentWindowTokens: 0, compressionRefusalCurveFallbacks: 0, l1HoldbackChunks: 0,
};
writeFileSync(RECIPE, JSON.stringify({ agent: { strategy: RECIPE_STRATEGY } }));
const SETTINGS = ['--model', MODEL, '--participant', 'Ada', '--recipe', RECIPE];

/** The resident: the options its recipe gives, and small chunks, each compressed as it closes. */
const RESIDENT = {
  ...residentStrategyOptions(RECIPE_STRATEGY, MODEL, 'Ada'),
  targetChunkTokens: 100, quarantineAlarmIntervalMs: 0, mergeAttemptLimit: 1,
};

type Answer = (request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => unknown;
const said = (request: Parameters<Answer>[0]): string =>
  request.messages.flatMap((m) => m.content).map((b) => b.text ?? '').join('\n');
let minted = 0;
/** An L1 or merge answer that carries reasoning, so its summary stores verbatim response blocks. */
const answers: Answer = () => ({
  stopReason: 'end_turn',
  content: [
    { type: 'thinking', thinking: 'thinking it over', signature: 'sig' },
    { type: 'text', text: `native memory ${minted++}` },
  ],
  usage: { inputTokens: 100, outputTokens: 30 },
});
const refuses: Answer = () => ({ stopReason: 'refusal', content: [], usage: { inputTokens: 100, outputTokens: 0 } });
const membraneOf = (answer: Answer) => ({ complete: async (request: never) => answer(request) }) as never;

let stores = 0;
/** A resident's store: `messages` rows chunked and compressed, each chunk answered by `answer`, with no merge yet. */
async function residentStore(answer: Answer = answers, messages = 40): Promise<string> {
  const path = join(dir, `store-${stores++}`);
  const strategy = new AutobiographicalStrategy({ ...RESIDENT, mergeThreshold: 99 } as never);
  const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane: membraneOf(answer) });
  for (let i = 0; i < messages; i++) {
    manager.addMessage(i % 2 ? 'Ada' : 'User', [{ type: 'text', text: `raw-${i} ${i === 0 ? 'POISON ' : ''}${'substantive '.repeat(12)}` }]);
  }
  await manager.compile();
  for (let i = 0; i < 12; i++) await manager.tick();
  manager.close();
  return path;
}

/** The resident, run on the store. */
async function asResident<T>(path: string, answer: Answer, body: (manager: ContextManager, strategy: AutobiographicalStrategy) => Promise<T>): Promise<T> {
  const strategy = new AutobiographicalStrategy(RESIDENT as never);
  const manager = await ContextManager.open({ path, namespace: NS, strategy, membrane: membraneOf(answer) });
  try {
    return await body(manager, strategy);
  } finally {
    manager.close();
  }
}

const STATES = ['summaries', 'chunks', 'mergeQueue', 'merge-quarantine'] as const;
function read<T>(path: string, body: (store: JsStore) => T): T {
  const store = JsStore.open({ path });
  try { return body(store); } finally { store.close(); }
}
const summariesOf = (path: string): SummaryEntry[] => read(path, (store) => store.getStateJson(`${NS}/autobio:summaries`) as SummaryEntry[]);
/**
 * The memory the store holds: its summaries, chunk records, merge queue and merge quarantine, the item count of every
 * strategy state, and the store's sequence, which any write to any state moves.
 */
const memory = (path: string): string => read(path, (store) => JSON.stringify([
  ...STATES.map((state) => store.getStateJson(`${NS}/autobio:${state}`)),
  store.listStates().filter((s) => s.id.startsWith(`${NS}/autobio:`)).map((s) => [s.id, s.itemCount ?? null]).sort(),
  store.currentSequence(),
]));

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const saved = { log: console.log, info: console.info, error: console.error, warn: console.warn };
  console.log = console.info = (...parts: unknown[]) => { stdout += `${format(...parts)}\n`; };
  console.error = console.warn = (...parts: unknown[]) => { stderr += `${format(...parts)}\n`; };
  try {
    return { code: await main(args), stdout, stderr };
  } finally {
    Object.assign(console, saved);
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
let files = 0;
function bodyFile(text: string): string {
  const path = join(dir, `body-${files++}.md`);
  writeFileSync(path, `${text}\n`);
  return path;
}
async function exported(path: string, target: string[]): Promise<{ file: string; item: MemoryWorkItem; request: Parameters<Answer>[0] }> {
  const file = join(dir, `export-${files++}.json`);
  const result = await run(['export-request', path, '--namespace', NS, ...target, '--out', file, ...SETTINGS]);
  assert.equal(result.code, 0, result.stderr);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  return { file, item: written.workItem, request: written.request };
}

const BODY = 'A consolidation written elsewhere: what the three stretches held.';

describe('external-memory', () => {
  it('exports the merge the strategy would do, and installs its text as that merge', async () => {
    const path = await residentStore();
    const l1s = summariesOf(path);
    assert.ok(l1s.length >= 4 && l1s.every((s) => s.level === 1), `setup: at least four L1s and no merge, got ${l1s.length}`);

    // What the resident itself merges first, on a twin of the store.
    const twin = join(dir, `twin-${stores++}`);
    cpSync(path, twin, { recursive: true });
    await asResident(twin, answers, (manager) => manager.tick());
    const own = summariesOf(twin).find((s) => s.level === 2)!;
    assert.ok(own, 'setup: the resident merges on its own');

    const before = memory(path);
    const { file, item, request } = await exported(path, ['--level', '2']);
    assert.equal(memory(path), before, 'an export writes nothing to the memory');
    assert.deepEqual(
      item,
      { level: 2, sourceLevel: 1, sourceIds: own.sourceIds, sourceRange: own.sourceRange, requestHash: sha256(JSON.stringify(request)) },
      'the work is the merge the strategy does itself, with the hash of its request',
    );
    assert.match(said(request), /raw-0 POISON/, 'the request holds the history under the sources');
    assert.equal((request as { config?: { model?: string } }).config?.model, MODEL, 'as the strategy hands it to membrane');

    const text = bodyFile(BODY);
    const importArgs = ['import', path, '--namespace', NS, '--descriptor', file, '--body-file', text, '--by', 'operator', '--note', 'refused five times'];
    const dry = await run(importArgs);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /DRY RUN/);
    assert.equal(memory(path), before, 'a dry run writes nothing to the memory');

    const applied = await run([...importArgs, '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    const after = summariesOf(path);
    const parent = after.find((s) => s.level === 2)!;
    assert.match(applied.stdout, new RegExp(`APPLIED: stored as ${parent.id}, `));
    assert.equal(parent.content, BODY);
    assert.deepEqual(parent.sourceIds, item.sourceIds);
    assert.equal(parent.sourceLevel, 1);
    assert.deepEqual(parent.sourceRange, item.sourceRange);
    assert.equal(parent.tokens, Math.ceil(BODY.length / 3), 'tokens stamped from the text');
    assert.equal(parent.responseContent, undefined, 'no reasoning carrier');
    assert.equal(parent.external?.by, 'operator');
    assert.equal(parent.external?.note, 'refused five times');
    assert.equal(typeof parent.external?.at, 'number');
    assert.equal(parent.provenance, undefined, 'no model call is named as its author');
    assert.equal(parent.external?.requestHash, item.requestHash, 'and it names the request it answers');
    for (const s of after.filter((s) => s.level === 1)) {
      assert.equal(s.mergedInto, item.sourceIds.includes(s.id) ? parent.id : undefined, `${s.id}'s parent`);
      assert.equal(s.external, undefined, 'the other entries are as they were');
    }
    assert.equal(after.filter((s) => s.level === 2).length, 1);

    // The resident compiles the new memory, with nothing added to it, and its merge check doesn't redo the merge.
    await asResident(path, answers, async (manager) => {
      // A budget loose enough for the L1s keeps them; tighten it until the picker folds to the merge.
      let rendered: string[] = [];
      let whole = '';
      for (let maxTokens = 1_000; maxTokens >= 650 && !rendered.includes(BODY); maxTokens -= 50) {
        const compiled = await manager.compile({ maxTokens, reserveForResponse: 50 });
        rendered = compiled.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
        whole = JSON.stringify(compiled.messages);
      }
      assert.ok(rendered.includes(BODY), 'the memory renders as its text alone');
      assert.doesNotMatch(whole, /operator|refused five times|external/i, 'nothing else of the import reaches the context');
      // Its own merges go on from the next group.
      await manager.tick();
      await manager.tick();
    });
    const over = summariesOf(path).filter((s) => s.level === 2 && s.sourceIds.some((id) => item.sourceIds.includes(id)));
    assert.deepEqual(over.map((s) => [s.id, s.content]), [[parent.id, BODY]], 'the merge is not done again');
    assert.ok(summariesOf(path).filter((s) => s.level === 2).length > 1, 'setup: the resident merged what came after');
    const next = await exported(path, ['--level', '2']).then((e) => e.item.sourceIds, () => []);
    assert.ok(!next.some((id) => item.sourceIds.includes(id)), 'and the next export is of other work');
  });

  it('refuses a descriptor that is no longer the work the strategy would do', async () => {
    const path = await residentStore();
    const { file, item } = await exported(path, ['--level', '2']);
    const text = bodyFile(BODY);
    const importArgs = (descriptor: string) => ['import', path, '--namespace', NS, '--descriptor', descriptor, '--body-file', text, '--by', 'operator', '--apply'];

    // Another grouping than the strategy's.
    const regrouped = join(dir, 'regrouped.json');
    writeFileSync(regrouped, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), workItem: { ...item, sourceIds: item.sourceIds.slice(0, 2) } }));
    const before = memory(path);
    const other = await run(importArgs(regrouped));
    assert.equal(other.code, 1);
    assert.match(other.stderr, /not what the strategy would do now/);
    assert.equal(memory(path), before);

    // The sources merged meanwhile: the resident did the merge itself.
    await asResident(path, answers, (manager) => manager.tick());
    const merged = memory(path);
    assert.equal(summariesOf(path).filter((s) => s.level === 2).length, 1, 'setup: the resident merged');
    const stale = await run(importArgs(file));
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /would merge nothing into L2 now|not what the strategy would do now/);
    assert.equal(memory(path), merged, 'nothing is written');
  });

  it('refuses a text written for a request the strategy no longer builds for the same work', async () => {
    const path = await residentStore();
    // The resident's first merge stands, and the next merge's request recalls it.
    await asResident(path, answers, (manager) => manager.tick());
    const first = summariesOf(path).find((s) => s.level === 2)!;
    assert.ok(first, 'setup: the resident merged once');
    const { file, item, request } = await exported(path, ['--level', '2']);
    assert.ok(!item.sourceIds.some((id) => first.sourceIds.includes(id)), 'setup: the work is the next merge');
    assert.ok(said(request).includes(first.content), 'setup: its request recalls the first merge');

    // The recalled memory's text changes: the work is the same, and its request isn't.
    const edited = await run(['edit', path, '--namespace', NS, '--id', first.id, '--body-file', bodyFile('The first stretch, rewritten.'), '--by', 'operator', '--drop-response-content', '--apply']);
    assert.equal(edited.code, 0, edited.stderr);
    const before = memory(path);
    const importArgs = ['import', path, '--namespace', NS, '--descriptor', file, '--body-file', bodyFile(BODY), '--by', 'operator'];
    for (const args of [importArgs, [...importArgs, '--apply']]) {
      const stale = await run(args);
      assert.equal(stale.code, 1, `${args.includes('--apply') ? 'applied' : 'dry run'}: ${stale.stdout}`);
      assert.match(stale.stderr, /is not the one exported/);
      assert.equal(memory(path), before, 'nothing is written');
    }

    // Exported again it is the same work with another request, which the text can answer.
    const again = await exported(path, ['--level', '2']);
    assert.deepEqual(again.item.sourceIds, item.sourceIds);
    assert.notEqual(again.item.requestHash, item.requestHash);
    const applied = await run(['import', path, '--namespace', NS, '--descriptor', again.file, '--body-file', bodyFile(BODY), '--by', 'operator', '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(summariesOf(path).find((s) => s.content === BODY)?.level, 2);
  });

  it('installs the text of a quarantined merge, and its quarantine is paid off', async () => {
    const path = await residentStore();
    await asResident(path, refuses, async (manager, strategy) => {
      await manager.tick();
      assert.equal(strategy.getMergeQuarantineStatus().count, 1, 'setup: the merge is quarantined');
    });
    const held = read(path, (store) => store.getStateJson(`${NS}/autobio:merge-quarantine`) as Array<{ level: number; sourceIds: string[]; lastRequestHash: string }>)[0]!;

    const before = memory(path);
    const { file, item, request } = await exported(path, ['--level', String(held.level)]);
    assert.equal(memory(path), before, 'the export leaves the quarantine as it is');
    assert.deepEqual(item.sourceIds, held.sourceIds, 'the work is the quarantined group');
    assert.equal(sha256(JSON.stringify(request)), held.lastRequestHash, 'and the request is the one the resident was refused on');
    const applied = await run(['import', path, '--namespace', NS, '--descriptor', file, '--body-file', bodyFile(BODY), '--by', 'operator', '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    const parent = summariesOf(path).find((s) => s.level === held.level)!;
    assert.equal(parent.content, BODY);
    assert.deepEqual(parent.sourceIds, held.sourceIds);
    assert.deepEqual(read(path, (store) => store.getStateJson(`${NS}/autobio:merge-quarantine`)), [], 'the record is gone');
  });

  it('refuses to read a request where the strategy would change its own state first, and changes nothing', async () => {
    const path = await residentStore();
    await asResident(path, refuses, async (manager, strategy) => {
      await manager.tick();
      assert.equal(strategy.getMergeQuarantineStatus().count, 1, 'setup: the merge is quarantined');
    });
    const held = read(path, (store) => store.getStateJson(`${NS}/autobio:merge-quarantine`) as Array<{ level: number; sourceIds: string[] }>)[0]!;
    // An operator hold on one of its sources: the strategy would skip the group, and queue the merge beside it instead.
    const holding = join(dir, 'holding-recipe.json');
    writeFileSync(holding, JSON.stringify({ agent: { strategy: { ...RECIPE_STRATEGY, mergeHoldSummaryIds: [held.sourceIds[1]] } } }));
    const out = join(dir, `export-${files++}.json`);
    const before = memory(path);
    const refused = await run([
      'export-request', path, '--namespace', NS, '--level', String(held.level), '--out', out,
      '--model', MODEL, '--participant', 'Ada', '--recipe', holding,
    ]);
    assert.equal(refused.code, 1);
    assert.equal(memory(path), before, 'nothing in the store changed: the merge queue is as it was');
    assert.match(refused.stderr, /would change its own state first \(checkMergeThreshold\)/);
    assert.equal(existsSync(out), false, 'and no request is written');
  });

  it('installs the L1 of a quarantined chunk, which clears its quarantine', async () => {
    // The first chunk is refused; the others compress.
    const path = await residentStore((request) => (said(request).includes('POISON') ? refuses(request) : answers(request)));
    const quarantine = () => asResident(path, answers, async (_manager, strategy) => strategy.getCompressionQuarantineStatus().count);
    assert.equal(await quarantine(), 1, 'setup: one chunk is quarantined');
    const record = read(path, (store) => store.getStateJson(`${NS}/autobio:chunks`) as Array<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>)
      .find((r) => !r.compressed)!;
    assert.ok(record, 'setup: its record is uncompressed');

    const before = memory(path);
    const { file, item, request } = await exported(path, ['--chunk', record.id]);
    assert.equal(memory(path), before);
    assert.deepEqual(item, {
      level: 1, sourceLevel: 0, sourceIds: record.sourceIds,
      sourceRange: { first: record.sourceIds[0], last: record.sourceIds[record.sourceIds.length - 1] }, chunkRecordId: record.id,
      requestHash: sha256(JSON.stringify(request)),
    });
    assert.match(said(request), /POISON/, 'the request is the chunk\'s compression');
    const refused = read(path, (store) => store.getStateJson(`${NS}/autobio:compression-refusal-quarantine-events`) as Array<{ kind: string; record?: { canonicalRequestHash: string } }>)
      .find((event) => event.kind === 'exhausted')!.record!.canonicalRequestHash;
    assert.equal(sha256(JSON.stringify(request)), refused, 'the one the resident was refused on');

    const applied = await run(['import', path, '--namespace', NS, '--descriptor', file, '--body-file', bodyFile(BODY), '--by', 'operator', '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    const l1 = summariesOf(path).find((s) => s.content === BODY)!;
    assert.equal(l1.level, 1);
    assert.deepEqual(l1.sourceIds, record.sourceIds);
    assert.equal(l1.external?.by, 'operator');
    assert.equal(l1.responseContent, undefined);
    const marked = read(path, (store) => store.getStateJson(`${NS}/autobio:chunks`) as Array<{ id: string; compressed: boolean; summaryId?: string }>)
      .find((r) => r.id === record.id)!;
    assert.deepEqual([marked.compressed, marked.summaryId], [true, l1.id], 'the chunk record names its L1');
    assert.equal(await quarantine(), 0, 'the quarantine is cleared');

    const again = await run(['import', path, '--namespace', NS, '--descriptor', file, '--body-file', bodyFile(BODY), '--by', 'operator', '--apply']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /compressed already/);
  });

  it('stores the text as the file holds it: nothing is read out of it as out of a model\'s answer', async () => {
    const path = await residentStore((request) => (said(request).includes('POISON') ? refuses(request) : answers(request)));
    const record = read(path, (store) => store.getStateJson(`${NS}/autobio:chunks`) as Array<{ id: string; compressed: boolean }>)
      .find((r) => !r.compressed)!;
    assert.ok(record, 'setup: the refused chunk is uncompressed');
    const { file } = await exported(path, ['--chunk', record.id]);
    // A model's answer of this shape strips to nothing, which the chunk's ladder records as an unusable answer.
    const text = '  <thinking>What the first stretch held, as worked out elsewhere.</thinking>';
    const applied = await run(['import', path, '--namespace', NS, '--descriptor', file, '--body-file', bodyFile(text), '--by', 'operator', '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    assert.ok(applied.stdout.includes(`text: ${text.length} chars, sha256 ${sha256(text)}`), 'the line printed is of the text stored');
    const l1 = summariesOf(path).find((s) => s.external)!;
    assert.equal(l1.content, text, 'wrapper and leading whitespace as given, the file\'s last newline dropped');
    assert.equal(l1.level, 1);
  });

  it('edits one summary\'s text: lineage kept, response blocks dropped on request, parents reported and left alone', async () => {
    const path = await residentStore();
    await asResident(path, answers, (manager) => manager.tick());
    const all = summariesOf(path);
    const parent = all.find((s) => s.level === 2)!;
    const target = all.find((s) => s.id === parent.sourceIds[1])!;
    assert.ok(target.responseContent && target.responseContent.length === 2, 'setup: the L1 carries its response blocks');
    assert.equal(target.provenance?.model, MODEL, 'setup: and the provenance of the call that wrote it');

    const text = bodyFile('The second stretch, rewritten by hand.');
    const args = ['edit', path, '--namespace', NS, '--id', target.id, '--body-file', text, '--by', 'operator', '--drop-response-content'];
    const before = memory(path);
    const dry = await run(args);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /DRY RUN/);
    assert.equal(memory(path), before, 'a dry run writes nothing to the memory');

    const applied = await run([...args, '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, new RegExp(`old text: ${target.content.length} chars, ${target.tokens} tokens, sha256 ${sha256(target.content)}`));
    assert.match(applied.stdout, /verbatim response blocks dropped \(the most on one entry\): 2/);
    assert.match(applied.stdout, new RegExp(`merged over the old text, left as they are: ${parent.id} \\(L2\\)`));

    const after = summariesOf(path);
    const edited = after.find((s) => s.id === target.id)!;
    assert.equal(edited.content, 'The second stretch, rewritten by hand.');
    assert.equal(edited.tokens, Math.ceil(edited.content.length / 3));
    assert.equal(edited.responseContent, undefined);
    assert.equal(edited.provenance, undefined, 'the call that wrote the old text is not named as the author of the new');
    assert.deepEqual(Object.keys(edited.external ?? {}), ['by', 'at']);
    assert.equal(edited.external?.by, 'operator');
    const lineage = (s: SummaryEntry) => [s.id, s.level, s.sourceLevel, s.sourceIds, s.sourceRange, s.mergedInto, s.parentId, s.created];
    assert.deepEqual(lineage(edited), lineage(target));
    assert.deepEqual(after.filter((s) => s.id !== target.id), all.filter((s) => s.id !== target.id), 'every other summary, its parent included, is as it was');

    // The store's history holds the old text, at the sequence the tool prints.
    const sequence = Number(/getStateJsonAt\('agents\/Ada\/autobio:summaries', (\d+)\)/.exec(applied.stdout)![1]);
    const old = read(path, (store) => store.getStateJsonAt(`${NS}/autobio:summaries`, sequence) as SummaryEntry[]).find((s) => s.id === target.id)!;
    assert.deepEqual(old, target);

    const missing = await run(['edit', path, '--namespace', NS, '--id', 'L1-9999', '--body-file', text, '--by', 'operator', '--apply']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no summary L1-9999/);
  });

  it('refuses to edit a summary whose verbatim response blocks would render in place of the new text, unless they are dropped', async () => {
    const path = await residentStore();
    const target = summariesOf(path).find((s) => (s.responseContent?.length ?? 0) > 0)!;
    assert.ok(target, 'setup: a summary that renders its response blocks');
    const before = memory(path);
    for (const apply of [[], ['--apply']]) {
      const refused = await run(['edit', path, '--namespace', NS, '--id', target.id, '--body-file', bodyFile('By hand.'), '--by', 'operator', ...apply]);
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, new RegExp(`summary ${target.id}, or an entry that carries it, holds 2 verbatim response block\\(s\\), which render in place of the text; dropResponseContent \\(or the CLI's --drop-response-content\\) deletes them`));
    }
    assert.equal(memory(path), before, 'nothing is written');
  });

  it('refuses an edit whose expected text is not the summary\'s, and makes the one whose text is', async () => {
    const path = await residentStore();
    const target = summariesOf(path)[0]!;
    await asResident(path, answers, async (manager) => {
      const options = { apply: true, dropResponseContent: true };
      assert.throws(
        () => manager.editSummaryText(target.id, 'By hand.', { by: 'operator' }, { ...options, expectedPriorSha256: sha256('another text') }),
        new RegExp(`summary ${target.id}'s text has sha256 ${sha256(target.content)}, not the ${sha256('another text')} given`),
      );
      assert.equal(manager.getSummary(target.id)?.content, target.content, 'the refused edit wrote nothing');
      const edit = manager.editSummaryText(target.id, 'By hand.', { by: 'operator' }, { ...options, expectedPriorSha256: sha256(target.content) });
      assert.equal(edit.applied, true);
    });
    assert.equal(summariesOf(path).find((s) => s.id === target.id)?.content, 'By hand.');
  });

  it('refuses to edit an entry that carries a summary up a level, naming that summary, and reports the carrier when the summary is edited', async () => {
    const path = await residentStore();
    const under = summariesOf(path)[1]!;
    const carrier: SummaryEntry = {
      id: 'L2-carry', level: 2, sourceLevel: 1, sourceIds: [under.id], carriedFrom: under.id, sourceRange: under.sourceRange,
      content: under.content, tokens: under.tokens, created: under.created,
      ...(under.responseContent ? { responseContent: under.responseContent } : {}),
    };
    read(path, (store) => {
      const all = store.getStateJson(`${NS}/autobio:summaries`) as SummaryEntry[];
      store.setStateJson(`${NS}/autobio:summaries`, [...all.map((s) => (s.id === under.id ? { ...s, mergedInto: carrier.id } : s)), carrier]);
      store.sync();
    });
    await asResident(path, answers, async (manager) => {
      assert.equal(manager.getSummary(carrier.id)?.carriedFrom, under.id, 'setup: the resident keeps the carried entry');
      for (const apply of [false, true]) {
        assert.throws(
          () => manager.editSummaryText(carrier.id, 'By hand.', { by: 'operator' }, { dropResponseContent: true, apply }),
          new RegExp(`summary ${carrier.id} carries ${under.id} up a level, .*: edit ${under.id}`),
          `apply: ${apply}`,
        );
      }
      const edit = manager.editSummaryText(under.id, 'By hand.', { by: 'operator' }, { dropResponseContent: true, apply: true });
      assert.deepEqual(edit.carriedBy, [{ id: carrier.id, level: 2 }]);
      assert.deepEqual(edit.parents, [], 'a carrier is not merged over the text: it reads it as it stands');
    });
    const after = summariesOf(path);
    const edited = after.find((s) => s.id === under.id)!;
    const carried = after.find((s) => s.id === carrier.id)!;
    assert.deepEqual(
      [carried.content, carried.tokens, carried.external, carried.responseContent, carried.provenance],
      [edited.content, edited.tokens, edited.external, undefined, undefined],
      'the carrier is written as the edited summary\'s copy again',
    );
    assert.equal(carried.carriedFrom, under.id);
  });

  it('checks the invocation whole before anything is opened', async () => {
    const nowhere = join(dir, 'no-such-store');
    for (const [args, message] of [
      [['install', nowhere], /the subcommand comes first/],
      [['edit', nowhere, '--namespace', NS, '--id', 'L1-0', '--body-file', 'x', '--by', 'me', '--force'], /unknown option --force for edit/],
      [['edit', nowhere, '--namespace', NS, '--id', 'L1-0', '--body-file', 'x'], /edit needs --by/],
      [['import', nowhere, '--namespace', NS, '--descriptor', 'd', '--body-file', 'x', '--by', 'a', '--by', 'b'], /option given twice: --by/],
      [['export-request', nowhere, '--namespace', NS, '--out', 'o', '--model', 'm', '--participant', 'p'], /one of --level and --chunk/],
      [['export-request', nowhere, '--namespace', NS, '--level', '1', '--out', 'o', '--model', 'm', '--participant', 'p'], /2 or above/],
      [['export-request', nowhere, '--namespace', NS, '--level', '2', '--out', 'o', '--model', 'm', '--participant', 'p', '--apply'], /unknown option --apply/],
    ] as Array<[string[], RegExp]>) {
      const result = await run(args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /Store not found/);
    }
    assert.equal(existsSync(nowhere), false);
  });
});
