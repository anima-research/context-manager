import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JsStore } from '@animalabs/chronicle';
import type { ToolDefinition } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { MemoryWorkItem, MemoryWorkTarget } from '../src/index.js';
import { latestToolsFromAnthropicLog, residentStrategyOptions } from './resident-settings.js';

const USAGE = [
  'Usage:',
  '  external-memory export-request <store-path> --namespace <ns> [--message-slot isolated|shared]',
  '      (--level <n> | --chunk <chunk-record-id>) --out <file> --model <model> --participant <name>',
  '      [--recipe <recipe.json>] [--tools-log <log>]',
  '  external-memory import <store-path> --namespace <ns> [--message-slot isolated|shared]',
  '      --descriptor <file> --body-file <file> --by <who> [--note <text>] [--apply]',
  '  external-memory edit <store-path> --namespace <ns> [--message-slot isolated|shared]',
  '      --id <summary-id> --body-file <file> --by <who> [--note <text>] [--apply]',
].join('\n');

type Slot = 'isolated' | 'shared';
type Command = 'export-request' | 'import' | 'edit';

const COMMON = ['--namespace', '--message-slot'];
const WRITE = ['--body-file', '--by', '--note'];
/** The options each subcommand takes with a value; --apply, where taken, has none. */
const VALUE_OPTIONS: Record<Command, readonly string[]> = {
  'export-request': [...COMMON, '--level', '--chunk', '--out', '--model', '--participant', '--recipe', '--tools-log'],
  import: [...COMMON, ...WRITE, '--descriptor'],
  edit: [...COMMON, ...WRITE, '--id'],
};

class UsageError extends Error {}

interface Invocation {
  command: Command;
  storePath: string;
  apply: boolean;
  options: Map<string, string>;
}

/** The invocation, checked whole; a malformed one throws a UsageError. */
function invocation(args: string[]): Invocation {
  const [command, storePath, ...rest] = args;
  if (command !== 'export-request' && command !== 'import' && command !== 'edit') {
    throw new UsageError('the subcommand comes first: export-request, import or edit');
  }
  if (storePath === undefined || storePath.startsWith('--')) throw new UsageError('the store path follows the subcommand');
  const options = new Map<string, string>();
  let apply = false;
  for (let at = 0; at < rest.length; at++) {
    const name = rest[at]!;
    if (name === '--apply' && command !== 'export-request') {
      if (apply) throw new UsageError('option given twice: --apply');
      apply = true;
      continue;
    }
    if (!VALUE_OPTIONS[command].includes(name)) {
      throw new UsageError(name.startsWith('-') ? `unknown option ${name} for ${command}` : `unexpected argument ${JSON.stringify(name)}`);
    }
    const value = rest[++at];
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    if (options.has(name)) throw new UsageError(`option given twice: ${name}`);
    options.set(name, value);
  }
  const required: Record<Command, string[]> = {
    'export-request': ['--namespace', '--out', '--model', '--participant'],
    import: ['--namespace', '--descriptor', '--body-file', '--by'],
    edit: ['--namespace', '--id', '--body-file', '--by'],
  };
  for (const name of required[command]) if (!options.has(name)) throw new UsageError(`${command} needs ${name}`);
  const slot = options.get('--message-slot');
  if (slot !== undefined && slot !== 'isolated' && slot !== 'shared') {
    throw new UsageError(`--message-slot takes isolated or shared, not ${JSON.stringify(slot)}`);
  }
  if (command === 'export-request') {
    if (options.has('--level') === options.has('--chunk')) throw new UsageError('export-request takes one of --level and --chunk');
    const level = options.get('--level');
    if (level !== undefined && !/^[2-9]$|^[1-9][0-9]+$/.test(level)) {
      throw new UsageError(`--level takes the level a merge writes, 2 or above, not ${JSON.stringify(level)}`);
    }
  }
  return { command, storePath, apply, options };
}

/** What an export wrote: the work, the settings the strategy read it under, and the request. */
interface ExportFile {
  workItem: MemoryWorkItem;
  settings: { strategy: Record<string, unknown>; systemPrompt?: string; tools?: ToolDefinition[] };
  request: unknown;
}

const AUDIT_OPEN = { autoTickOnNewMessage: false, topologyPolicy: 'report', auditOnly: true } as const;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: Invocation;
  try {
    parsed = invocation(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 1;
  }
  const { command, storePath, apply, options } = parsed;
  const namespace = options.get('--namespace')!;
  const by = { by: options.get('--by')!, ...(options.has('--note') ? { note: options.get('--note')! } : {}) };

  // Every file the invocation names is read before the store is opened.
  let settings: ExportFile['settings'];
  let body = '';
  let described: MemoryWorkItem | undefined;
  try {
    if (command === 'export-request') {
      const recipe = options.has('--recipe')
        ? JSON.parse(readFileSync(options.get('--recipe')!, 'utf8')) as { agent?: { systemPrompt?: string; strategy?: Record<string, unknown> } }
        : undefined;
      const tools = options.has('--tools-log') ? latestToolsFromAnthropicLog(options.get('--tools-log')!) : [];
      settings = {
        strategy: residentStrategyOptions(recipe?.agent?.strategy ?? {}, options.get('--model')!, options.get('--participant')!),
        ...(recipe?.agent?.systemPrompt ? { systemPrompt: recipe.agent.systemPrompt } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      };
    } else {
      // The text as the file holds it, less the whitespace that ends it.
      body = readFileSync(options.get('--body-file')!, 'utf8').trimEnd();
      if (body.length === 0) throw new Error(`${options.get('--body-file')} holds no text`);
      if (command === 'import') {
        const file = JSON.parse(readFileSync(options.get('--descriptor')!, 'utf8')) as Partial<ExportFile>;
        if (!file.workItem || !file.settings?.strategy) throw new Error(`${options.get('--descriptor')} is not a file export-request wrote`);
        described = file.workItem;
        settings = file.settings;
      } else {
        settings = { strategy: { adaptiveResolution: true, hierarchical: true } };
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    return 1;
  }

  let store: JsStore;
  try {
    store = JsStore.open({ path: storePath });
  } catch (error) {
    if (!/locked/i.test(String((error as Error | undefined)?.message ?? error))) throw error;
    console.error(`The store at ${storePath} is locked: a running resident (or another process) holds it open. Stop it first. Nothing was done.`);
    return 1;
  }
  try {
    // The namespace and its message slot, as inspect-store settles them.
    const stateIds = new Set(store.listStates().map((state) => state.id));
    if (!stateIds.has(`${namespace}/autobio:summaries`)) {
      console.error(`namespace "${namespace}" has no strategy state (no ${namespace}/autobio:summaries); nothing was done.`);
      return 2;
    }
    const slotIds: Record<Slot, string> = { isolated: `${namespace}/messages`, shared: 'messages' };
    const chosen = options.get('--message-slot') as Slot | undefined;
    const registered = (['isolated', 'shared'] as const).filter((slot) => stateIds.has(slotIds[slot]));
    if (chosen ? !registered.includes(chosen) : registered.length !== 1) {
      console.error(
        (chosen
          ? `--message-slot ${chosen}: ${slotIds[chosen]} is not registered in this store`
          : registered.length === 0
            ? `"${namespace}" has no message slot (neither ${slotIds.isolated} nor ${slotIds.shared} is registered)`
            : `"${namespace}" has both message slots registered, ${slotIds.isolated} (isolated) and ${slotIds.shared} (shared), and the ` +
              'store doesn\'t record which one its resident uses; choose with --message-slot isolated or --message-slot shared') +
          '; nothing was done.',
      );
      return 2;
    }
    const slot = chosen ?? registered[0]!;

    const strategy = new AutobiographicalStrategy({ ...settings.strategy, ...AUDIT_OPEN });
    const membrane = { complete: async () => { throw new Error('external-memory makes no model call'); } };
    const unopened = store.currentSequence();
    const manager = await ContextManager.open({
      store, strategy, membrane: membrane as never, namespace, ...(slot === 'isolated' ? { isolate: true } : {}),
    });
    try {
      // What the lines below say was written is the command's; the open's own writes are said here.
      if (store.currentSequence() !== unopened) {
        console.error(
          `note: opening the store wrote the load-time repairs any open of it makes (see auditOnly): ` +
            `its sequence went from ${unopened} to ${store.currentSequence()}.`,
        );
      }
      if (settings.tools) manager.setToolDefinitions(settings.tools);
      if (settings.systemPrompt) manager.setSystemPrompt(settings.systemPrompt);
      const describe = (item: MemoryWorkItem): string =>
        `L${item.level} over ${item.sourceIds.length} ${item.sourceLevel === 0 ? 'message(s)' : `L${item.sourceLevel}(s)`} ` +
        `[${item.sourceIds.join(', ')}], range ${item.sourceRange.first}..${item.sourceRange.last}` +
        (item.chunkRecordId !== undefined ? `, chunk record ${item.chunkRecordId}` : '');

      if (command === 'export-request') {
        const target: MemoryWorkTarget = options.has('--chunk')
          ? { chunkRecordId: options.get('--chunk')! }
          : { level: Number(options.get('--level')) };
        const { item, request } = await manager.exportMemoryRequest(target);
        const out: ExportFile = { workItem: item, settings, request };
        writeFileSync(options.get('--out')!, JSON.stringify(out, null, 2));
        console.log(`work: ${describe(item)}`);
        console.log(`request: ${request.messages.length} message(s), sha256 ${item.requestHash}`);
        console.log(`wrote ${options.get('--out')}: workItem, settings and request. Nothing was written to the store's memory.`);
        return 0;
      }

      if (command === 'import') {
        const result = await manager.importExternalMemory(described!, body, by, { apply });
        console.log(`work: ${describe(result.item)}`);
        console.log(`text: ${body.length} chars, sha256 ${sha256(body)}, by ${by.by}`);
        console.log(result.applied
          ? `APPLIED: stored as ${result.summaryId}, ${result.tokens} tokens.`
          : `DRY RUN: the strategy would do this work now, from the request exported (sha256 ${result.item.requestHash}), and the ` +
            `text would be stored as its summary (~${result.tokens} tokens). Nothing written; run again with --apply.`);
        return 0;
      }

      const sequence = store.currentSequence();
      const edit = manager.editSummaryText(options.get('--id')!, body, by, { apply });
      console.log(`summary: ${edit.id} (L${edit.level})`);
      console.log(`old text: ${edit.prior.length} chars, ${edit.prior.tokens} tokens, sha256 ${edit.prior.sha256}`);
      console.log(`new text: ${body.length} chars, ${edit.tokens} tokens, sha256 ${sha256(body)}, by ${by.by}`);
      console.log(`verbatim response blocks dropped: ${edit.droppedResponseBlocks}`);
      console.log(edit.parents.length === 0
        ? 'merged over the old text: nothing'
        : `merged over the old text, left as they are: ${edit.parents.map((parent) => `${parent.id} (L${parent.level})`).join(', ')}`);
      console.log(edit.applied
        ? `APPLIED. The old text stays in the store's history: getStateJsonAt('${namespace}/autobio:summaries', ${sequence}) holds ${edit.id} as it was.`
        : 'DRY RUN: nothing written; run again with --apply.');
      return 0;
    } finally {
      manager.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (!store.isClosed()) store.close();
  }
}
