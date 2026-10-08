/**
 * Inspect a chronicle store's autobiographical memory: its messages, the
 * summary tree and lineage, and the adaptive resolutions, written as files
 * under --output with an overview on stdout.
 *
 * Usage:
 *   node dist/scripts/inspect-store.js <store-path> [--namespace <ns>] [--message-slot isolated|shared] [--output <dir>] [--sample-compile <tokens>]
 *
 * The invocation is checked whole before anything is opened: the store path
 * comes first, then only the options above, each at most once and each with
 * its value. Anything else (an unknown or misspelled option, a stray
 * argument, an option given twice, an option without its value) is refused,
 * never read around, so a malformed selection can't fall back to a default.
 *
 * `--namespace` is the strategy namespace (default "default"; residents use
 * e.g. agents/<Name>). `--ns` is accepted as its old name.
 *
 * `--message-slot` says where the resident keeps its messages: `isolated`
 * for a ContextManager opened with `isolate: true` (the slot
 * `{namespace}/messages`), `shared` for one opened without it (the slot
 * `messages`). The store doesn't record which, and a registered slot is not
 * proof the resident uses it: an isolated slot outlives a switch to shared
 * messages. So a chosen slot must be registered; without a choice the sole
 * registered slot is read, and when both are registered nothing is
 * inspected until one is chosen. The overview and the files name the slot
 * they read.
 *
 * Mutation-free strategy inspection: the store is opened with JsStore.open
 * (it is never created), the strategy's persisted state is read as stored,
 * and no strategy or ContextManager is constructed. So inspection creates no
 * strategy, chunk or namespace state and registers nothing for a namespace;
 * a namespace without strategy state is reported and nothing else is done.
 * Messages are read through a MessageStore, whose construction re-registers
 * the message slot's history indexes, idempotently, as every open of the
 * store does, rebuilding any that are missing or stale.
 *
 * Inspection is mutation-free logically, not byte-for-byte. Chronicle has no
 * read-only open: opening takes the store's lock, so run this on a stopped
 * resident's store or on a copy. Every close rewrites state.bin,
 * state-indexes.bin (where a rebuilt history index lands) and branches.bin,
 * whose bytes can change even when what they hold doesn't. And when the
 * store wasn't closed cleanly, opening may correct stale branch heads, which
 * the close writes to branches.bin, and truncate a torn tail from
 * records.log; a truncation is reported on stderr, even when the open then
 * fails, since nothing records it afterwards. So to keep a store's files as
 * they were, as forensics during an incident needs, copy the store before
 * inspecting it.
 *
 * `--sample-compile <tokens>` additionally writes one compile at that
 * budget from a live, audit-only open of the same message slot, using this
 * tool's default strategy configuration (not the resident's own, so it is a
 * sample, not a reproduction of the resident's view). That open registers
 * the namespace's states and may migrate legacy chunk records: use it on a
 * copy. With no message slot there is no history to compile, so it is
 * refused.
 *
 * Exit code 0 = inspected; 2 = nothing inspected because the store doesn't
 * settle the selection (the namespace has no strategy state, or its message
 * slot is absent or must be chosen); 1 = could not open, or a malformed
 * invocation.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy, MessageStore } from '../src/index.js';

interface SummaryEntry {
  id: string;
  level: number;
  content: string;
  tokens: number;
  sourceLevel: number;
  sourceIds: string[];
  sourceRange: { first: string; last: string };
  parentId?: string;
  mergedInto?: string;
}

const USAGE = 'Usage: inspect-store <store-path> [--namespace <ns>] [--message-slot isolated|shared] [--output <dir>] [--sample-compile <tokens>]';

type Slot = 'isolated' | 'shared';

/** The options, by every name they are accepted under. */
type Option = 'namespace' | 'messageSlot' | 'output' | 'sampleCompile';
const OPTIONS: ReadonlyMap<string, Option> = new Map<string, Option>([
  ['--namespace', 'namespace'],
  ['--ns', 'namespace'],
  ['--message-slot', 'messageSlot'],
  ['--output', 'output'],
  ['--sample-compile', 'sampleCompile'],
]);

class UsageError extends Error {}

interface Invocation {
  storePath: string;
  namespace: string;
  slotChoice?: Slot;
  outputDir: string;
  sampleTokens?: number;
}

/** The invocation, checked whole; a malformed one throws a UsageError. */
function invocation(args: string[]): Invocation {
  const [storePath, ...rest] = args;
  if (storePath === undefined || storePath.startsWith('--')) throw new UsageError('the store path comes first');
  const given = new Map<Option, { name: string; value: string }>();
  for (let at = 0; at < rest.length; at += 2) {
    const name = rest[at]!;
    const option = OPTIONS.get(name);
    if (option === undefined) {
      throw new UsageError(name.startsWith('-') ? `unknown option ${name}` : `unexpected argument ${JSON.stringify(name)}`);
    }
    const value = rest[at + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    const earlier = given.get(option);
    if (earlier) throw new UsageError(`option given twice: ${earlier.name} and ${name}`);
    given.set(option, { name, value });
  }
  const slotRaw = given.get('messageSlot')?.value;
  if (slotRaw !== undefined && slotRaw !== 'isolated' && slotRaw !== 'shared') {
    throw new UsageError(`--message-slot takes isolated or shared, not ${JSON.stringify(slotRaw)}`);
  }
  const sampleRaw = given.get('sampleCompile')?.value;
  const sampleTokens = sampleRaw === undefined ? undefined : Number(sampleRaw);
  if (sampleTokens !== undefined && !(Number.isInteger(sampleTokens) && sampleTokens > 0)) {
    throw new UsageError(`--sample-compile takes a positive whole number of tokens, not ${JSON.stringify(sampleRaw)}`);
  }
  return {
    storePath,
    namespace: given.get('namespace')?.value ?? 'default',
    slotChoice: slotRaw,
    outputDir: given.get('output')?.value ?? './inspection-output',
    sampleTokens,
  };
}

function textOf(content: Array<{ type?: string; text?: string }>): string {
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
}

async function main(): Promise<number> {
  let parsed: Invocation;
  try {
    parsed = invocation(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 1;
  }
  const { storePath, namespace, slotChoice, outputDir, sampleTokens } = parsed;
  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    return 1;
  }

  // Chronicle's open truncates a torn tail from records.log before the steps that can still make the open fail, and
  // nothing records the truncation afterwards. Its recovery() report needs the opened store, which a failed open
  // doesn't leave, so compare the log's size across the open instead, and report whether or not the open succeeds.
  const log = `${storePath}/records.log`;
  const logSize = () => (existsSync(log) ? statSync(log).size : 0);
  const sizeBefore = logSize();
  let store: JsStore;
  try {
    store = JsStore.open({ path: storePath });
  } finally {
    const size = logSize();
    if (size < sizeBefore) {
      const dropped = sizeBefore - size;
      console.error(
        `⚠️ Opening this store truncated a torn tail from records.log: it dropped ${dropped} byte${dropped === 1 ? '' : 's'}, ` +
          `and the log now ends at byte ${size}. A torn tail is whatever follows the last record that reads whole: ` +
          'usually an append that didn\'t complete, which a crash can leave, and so can copying a store while its ' +
          'resident writes. Those bytes are gone from this store, and later opens won\'t report them.',
      );
    }
  }
  try {
    const stateIds = new Set(store.listStates().map((state) => state.id));
    const summariesId = `${namespace}/autobio:summaries`;
    if (!stateIds.has(summariesId)) {
      const withState = [...stateIds]
        .filter((id) => id.endsWith('/autobio:summaries'))
        .map((id) => id.slice(0, -'/autobio:summaries'.length));
      console.error(
        `⚠️ namespace "${namespace}" has no strategy state (no ${summariesId}); nothing was inspected. ` +
          (withState.length > 0
            ? `Namespaces with strategy state: ${withState.join(', ')}.`
            : 'No namespace in this store has strategy state.'),
      );
      return 2;
    }

    // Which message slot (see the header). Every refusal here comes before any message is read or any output written.
    const slotIds: Record<Slot, string> = { isolated: `${namespace}/messages`, shared: 'messages' };
    const registered = (slot: Slot) => stateIds.has(slotIds[slot]);
    let slot: Slot | undefined;
    if (slotChoice !== undefined) {
      if (!registered(slotChoice)) {
        const other: Slot = slotChoice === 'isolated' ? 'shared' : 'isolated';
        console.error(
          `⚠️ --message-slot ${slotChoice}: ${slotIds[slotChoice]} is not registered in this store; nothing was inspected. ` +
            (registered(other) ? `The ${other} slot ${slotIds[other]} is.` : `Nor is the ${other} slot ${slotIds[other]}.`),
        );
        return 2;
      }
      slot = slotChoice;
    } else if (registered('isolated') && registered('shared')) {
      console.error(
        `⚠️ "${namespace}" has both message slots registered, ${slotIds.isolated} (isolated) and ${slotIds.shared} (shared), ` +
          'and the store doesn\'t record which one its resident uses (ContextManager\'s isolate): a registered slot can be left ' +
          'over from an earlier configuration. Nothing was inspected; choose with --message-slot isolated or --message-slot shared.',
      );
      return 2;
    } else {
      slot = registered('isolated') ? 'isolated' : registered('shared') ? 'shared' : undefined;
    }
    if (slot === undefined && sampleTokens !== undefined) {
      console.error(
        `⚠️ --sample-compile: "${namespace}" has no message slot (neither ${slotIds.isolated} nor ${slotIds.shared} is registered), ` +
          'so there is no history to compile; nothing was inspected.',
      );
      return 2;
    }
    const slotLabel = slot === undefined ? 'no message slot' : `the ${slot} message slot ${slotIds[slot]}`;

    const messages = slot === undefined ? [] : new MessageStore(store, slot === 'isolated' ? { namespace } : {}).getAll();
    const stored = store.getStateJson(summariesId);
    const summaries = (Array.isArray(stored) ? stored : []) as SummaryEntry[];
    const resolutionState = store.getStateJson(`${namespace}/autobio:resolutions`);
    const resolutions = new Map<string, number>();
    if (resolutionState && typeof resolutionState === 'object') {
      for (const [id, level] of Object.entries(resolutionState as Record<string, unknown>)) {
        if (typeof level === 'number' && level > 0) resolutions.set(id, level);
      }
    }

    mkdirSync(outputDir, { recursive: true });

    // === Overview ===
    const byLevel: Record<number, number> = {};
    for (const s of summaries) byLevel[s.level] = (byLevel[s.level] ?? 0) + 1;
    const bodyGroups = new Map<string, number>();
    for (const m of messages) {
      if (m.bodyGroupId) bodyGroups.set(m.bodyGroupId, (bodyGroups.get(m.bodyGroupId) ?? 0) + 1);
    }
    console.log(`=== Overview (${namespace}) ===`);
    console.log(`Messages: ${messages.length} (${slotLabel})`);
    console.log(`Summaries: ${summaries.length} (${JSON.stringify(byLevel)})`);
    console.log(`BodyGroups: ${bodyGroups.size}`);
    for (const [gid, count] of [...bodyGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`  ${gid}: ${count} shards`);
    }
    console.log(`Resolutions recorded: ${resolutions.size}`);
    const resDist: Record<number, number> = {};
    for (const level of resolutions.values()) resDist[level] = (resDist[level] ?? 0) + 1;
    console.log(`Resolution distribution: ${JSON.stringify(resDist)}`);

    // === Summary tree ===
    const byId = new Map(summaries.map((s) => [s.id, s]));
    const sortedByLevel = [...summaries].sort((a, b) =>
      a.level !== b.level ? b.level - a.level : a.sourceRange.first.localeCompare(b.sourceRange.first));
    const tree: string[] = ['# Summary tree\n', 'Sorted by level (highest first), then by source order.\n'];
    for (const s of sortedByLevel) {
      const parent = s.parentId ?? s.mergedInto;
      tree.push(`\n## ${s.id} (L${s.level}, ${s.tokens} tokens)${parent ? ` parent=${parent}` : ''}`);
      tree.push(`sourceLevel=${s.sourceLevel} sources=${s.sourceIds.length} range=${s.sourceRange.first}…${s.sourceRange.last}`);
      tree.push('', s.content, '', '---');
    }
    writeFileSync(`${outputDir}/summary-tree.md`, tree.join('\n'));
    console.log(`\nWrote summary tree → ${outputDir}/summary-tree.md`);

    // === Lineage: the leaf message ids each summary ultimately covers ===
    const leaves = (s: SummaryEntry, visited = new Set<string>()): string[] => {
      if (visited.has(s.id)) return [];
      visited.add(s.id);
      if (s.sourceLevel === 0) return [...s.sourceIds];
      return s.sourceIds.flatMap((id) => {
        const child = byId.get(id);
        return child ? leaves(child, visited) : [];
      });
    };
    const lineage: string[] = ['# Summary lineage\n', 'For each summary: the leaf message ids it ultimately covers.\n'];
    for (const s of sortedByLevel) {
      const ids = leaves(s);
      lineage.push(`\n## ${s.id} (L${s.level})`);
      lineage.push(`Source range: ${s.sourceRange.first} … ${s.sourceRange.last}`);
      lineage.push(`Leaf message ids (${ids.length}): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? `, … ${ids[ids.length - 1]}` : ''}`);
    }
    writeFileSync(`${outputDir}/summary-lineage.md`, lineage.join('\n'));
    console.log(`Wrote summary lineage → ${outputDir}/summary-lineage.md`);

    // === Messages ===
    const listing: string[] = ['# Messages\n', `Total stored: ${messages.length} (${slotLabel})\n`];
    messages.forEach((m, i) => {
      const text = textOf(m.content as Array<{ type?: string; text?: string }>);
      const shard = m.bodyGroupId ? ` [shard ${m.shardIndex}/${bodyGroups.get(m.bodyGroupId)} of ${m.bodyGroupId.slice(0, 12)}…]` : '';
      const res = resolutions.has(m.id) ? ` res=L${resolutions.get(m.id)}` : '';
      listing.push(`[${String(i).padStart(3, '0')}] ${m.participant} ${Math.ceil(text.length / 4)}t${shard}${res}: ${text.slice(0, 100).replace(/\n/g, '\\n')}`);
    });
    writeFileSync(`${outputDir}/messages.md`, listing.join('\n'));
    console.log(`Wrote messages → ${outputDir}/messages.md`);

    // === Optional sample compile: a live, audit-only open of the same slot ===
    if (sampleTokens !== undefined) {
      console.error(
        `--sample-compile: a live, audit-only sample of "${namespace}" from ${slotLabel}, using this tool's default strategy ` +
          'configuration (not the resident\'s); this open registers the namespace\'s states and may migrate legacy chunk records',
      );
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true,
        hierarchical: true,
        autoTickOnNewMessage: false,
        topologyPolicy: 'report',
        auditOnly: true,
      });
      const membrane = { complete: async () => ({ content: [{ type: 'text', text: '[inspect]' }] }) };
      const manager = await ContextManager.open({
        store, strategy, membrane: membrane as never, namespace, ...(slot === 'isolated' ? { isolate: true } : {}),
      });
      try {
        const compiled = await manager.compile({
          maxTokens: sampleTokens,
          reserveForResponse: Math.min(4_000, Math.floor(sampleTokens / 10)),
        });
        const lines: string[] = [
          `# Sample compile (${sampleTokens}-token budget)\n`,
          `A live, audit-only sample of "${namespace}" from ${slotLabel}, using inspect-store's default strategy configuration, not the resident's own.\n`,
          "Producing it opened the store live, which registers the namespace's states and may migrate legacy chunk records; make samples from a copy of the store.\n",
          `Entries: ${compiled.messages.length}\n`,
        ];
        compiled.messages.forEach((m, i) => {
          const text = textOf(m.content as Array<{ type?: string; text?: string }>);
          lines.push(`\n## [${i}] ${m.participant} (${Math.ceil(text.length / 4)} tokens)`, '', text, '', '---');
        });
        writeFileSync(`${outputDir}/sample-compile-${sampleTokens}.md`, lines.join('\n'));
        console.log(`Wrote sample compile → ${outputDir}/sample-compile-${sampleTokens}.md`);
      } finally {
        manager.close();
      }
    }

    console.log(`\nAll outputs in ${outputDir}/`);
    return 0;
  } finally {
    if (!store.isClosed()) store.close();
  }
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error('FATAL:', error);
  process.exitCode = 1;
});
