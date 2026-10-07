/**
 * Inspect a chronicle store's autobiographical memory: its messages, the
 * summary tree and lineage, and the adaptive resolutions, written as files
 * under --output with an overview on stdout.
 *
 * Usage:
 *   node dist/scripts/inspect-store.js <store-path> [--namespace <ns>] [--output <dir>] [--sample-compile <tokens>]
 *
 * `--namespace` is the strategy namespace (default "default"; residents use
 * e.g. agents/<Name>). `--ns` is accepted as its old name.
 *
 * Mutation-free strategy inspection: the store is opened with JsStore.open
 * (it is never created), the strategy's persisted state is read as stored,
 * and no strategy or ContextManager is constructed. So inspection creates no
 * strategy, chunk or namespace state and registers nothing for a namespace;
 * a namespace without strategy state is reported and nothing else is done.
 * Messages are read through a MessageStore, whose construction re-registers
 * the message slot's history indexes, idempotently, as every open of the
 * store does. Chronicle has no read-only open: opening takes the store's lock
 * and may rewrite its state index, so run this on a stopped resident's store
 * or on a copy.
 *
 * `--sample-compile <tokens>` additionally opens the store as a resident
 * would (an audit-only strategy under a ContextManager) and writes one compile
 * at that budget. That open registers the namespace's states and may migrate
 * legacy chunk records: use it on a copy.
 *
 * Exit code 0 = inspected, 2 = the namespace has no strategy state, 1 = could
 * not open or bad arguments.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

const USAGE = 'Usage: inspect-store <store-path> [--namespace <ns>] [--output <dir>] [--sample-compile <tokens>]';

function option(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const at = args.indexOf(name);
    if (at >= 0) return args[at + 1];
  }
  return undefined;
}

function textOf(content: Array<{ type?: string; text?: string }>): string {
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const storePath = args[0];
  if (!storePath || storePath.startsWith('--')) {
    console.error(USAGE);
    return 1;
  }
  const namespace = option(args, '--namespace', '--ns') ?? 'default';
  const outputDir = option(args, '--output') ?? './inspection-output';
  const sampleRaw = option(args, '--sample-compile');
  const sampleTokens = sampleRaw === undefined ? undefined : Number(sampleRaw);
  if (sampleTokens !== undefined && !(Number.isInteger(sampleTokens) && sampleTokens > 0)) {
    console.error(`--sample-compile takes a positive whole number of tokens, not ${JSON.stringify(sampleRaw)}\n${USAGE}`);
    return 1;
  }
  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    return 1;
  }

  const store = JsStore.open({ path: storePath });
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

    // An isolated resident keeps its messages in its own slot; others share one.
    const ownSlot = stateIds.has(`${namespace}/messages`);
    const messages = ownSlot || stateIds.has('messages')
      ? new MessageStore(store, ownSlot ? { namespace } : {}).getAll()
      : [];
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
    console.log(`Messages: ${messages.length}${ownSlot ? ` (slot ${namespace}/messages)` : ''}`);
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
    const listing: string[] = ['# Messages\n', `Total stored: ${messages.length}\n`];
    messages.forEach((m, i) => {
      const text = textOf(m.content as Array<{ type?: string; text?: string }>);
      const shard = m.bodyGroupId ? ` [shard ${m.shardIndex}/${bodyGroups.get(m.bodyGroupId)} of ${m.bodyGroupId.slice(0, 12)}…]` : '';
      const res = resolutions.has(m.id) ? ` res=L${resolutions.get(m.id)}` : '';
      listing.push(`[${String(i).padStart(3, '0')}] ${m.participant} ${Math.ceil(text.length / 4)}t${shard}${res}: ${text.slice(0, 100).replace(/\n/g, '\\n')}`);
    });
    writeFileSync(`${outputDir}/messages.md`, listing.join('\n'));
    console.log(`Wrote messages → ${outputDir}/messages.md`);

    // === Optional sample compile: a live, audit-only open ===
    if (sampleTokens !== undefined) {
      console.error(
        `--sample-compile: opening "${namespace}" as a resident would (audit-only); ` +
          'this registers the namespace\'s states and may migrate legacy chunk records',
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
        store, strategy, membrane: membrane as never, namespace, ...(ownSlot ? { isolate: true } : {}),
      });
      try {
        const compiled = await manager.compile({
          maxTokens: sampleTokens,
          reserveForResponse: Math.min(4_000, Math.floor(sampleTokens / 10)),
        });
        const lines: string[] = [`# Sample compile (${sampleTokens}-token budget)\n`, `Entries: ${compiled.messages.length}\n`];
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
