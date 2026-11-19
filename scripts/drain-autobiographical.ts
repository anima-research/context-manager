/**
 * Offline autobiographical compression drain for a copied Chronicle store.
 * This performs real provider calls and writes summaries; --apply is required.
 * It never starts an agent inference or connects MCPL modules.
 *
 * Usage:
 *   drain-autobiographical <copied-store> <namespace> --apply \
 *     --model=claude-fable-5 --participant=fable [--max-steps=200] \
 *     [--recipe=<recipe.json>] [--tools-log=<log>] [--clear-merge-quarantine=<key>]...
 *
 * --recipe gives the resident's settings (after a rebuild, the ones its plan
 * read), --tools-log a log of the resident's requests for a summarizer that
 * needs tool definitions, and --clear-merge-quarantine a merge-quarantine
 * key to clear before the first tick (repeatable). Its finish line says why
 * it stopped (`stopped`): drained, waiting-on-tools, max-steps, tick-error or
 * debt-unreadable.
 * Run again, it goes on from the store as it stands.
 */

import {
  AnthropicAdapter,
  Membrane,
  NativeFormatter,
} from '@animalabs/membrane';
import { readFileSync } from 'node:fs';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import { DEFAULT_RUNS_CONFIG } from '../src/repair/topology.js';
import { latestToolsFromAnthropicLog, residentStrategyOptions } from './resident-settings.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter((arg) => !arg.startsWith('--'));
const [storePath, namespace] = positional;
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const model = option('model');
const participant = option('participant');
const maxSteps = Number(option('max-steps') ?? '200');
const toolsLog = option('tools-log');
const recipePath = option('recipe');
const clearMergeQuarantineKeys = args
  .filter((arg) => arg.startsWith('--clear-merge-quarantine='))
  .map((arg) => arg.slice('--clear-merge-quarantine='.length))
  .filter(Boolean);

if (!storePath || !namespace || !model || !participant || !apply) {
  console.error(
    'usage: drain-autobiographical <copied-store> <namespace> --apply ' +
      '--model=<resident-model> --participant=<resident> [--max-steps=200] ' +
      '[--recipe=<recipe.json>] [--tools-log=<log>] [--clear-merge-quarantine=<key>]...',
  );
  process.exit(2);
}
if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
  console.error(`invalid --max-steps=${String(maxSteps)}`);
  process.exit(2);
}

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!authToken && !apiKey) {
  console.error('ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required');
  process.exit(2);
}

const adapter = new AnthropicAdapter({
  ...(authToken
    ? {
        authToken,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
      }
    : { apiKey: apiKey! }),
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});
const membrane = new Membrane(adapter, {
  formatter: new NativeFormatter(),
  assistantParticipant: participant,
});
const recipe = recipePath
  ? JSON.parse(readFileSync(recipePath, 'utf8')) as {
      agent?: { systemPrompt?: string; strategy?: Record<string, unknown> };
    }
  : undefined;
const recipeStrategy = recipe?.agent?.strategy ?? {};
class DrainStrategy extends AutobiographicalStrategy {
  protected override landsAsPlanned(): boolean {
    return true;
  }
  get mergesUnpicked(): boolean {
    return this.mergePicksWaiting;
  }
  get runs() {
    const c = this.config;
    return {
      mergeThreshold: c.mergeThreshold ?? 6,
      mergeMaxSourceSpanMessages: c.mergeMaxSourceSpanMessages ?? DEFAULT_RUNS_CONFIG.mergeMaxSourceSpanMessages,
      mergeHoldSummaryIds: c.mergeHoldSummaryIds ?? [],
      speculativeProduction: c.speculativeProduction !== false,
      l1HoldbackChunks: c.l1HoldbackChunks ?? 1,
      // Named only when the recipe sets it, as a plan made with --carry-stranded-summaries read it.
      ...(c.carryStrandedSummaries === true ? { carryStrandedSummaries: true } : {}),
    };
  }
}
const strategy = new DrainStrategy(residentStrategyOptions(recipeStrategy, model, participant));
const tools = toolsLog ? latestToolsFromAnthropicLog(toolsLog) : [];

const manager = await ContextManager.open({
  path: storePath,
  namespace,
  strategy,
  membrane,
});
if (tools.length > 0) manager.setToolDefinitions(tools);
if (recipe?.agent?.systemPrompt) manager.setSystemPrompt(recipe.agent.systemPrompt);
for (const key of clearMergeQuarantineKeys) strategy.clearMergeQuarantine(key);

const compact = () => {
  const progress = strategy.getProgressSnapshot();
  const debt = strategy.getCompressionDebt();
  return {
    l1Queue: progress.l1QueueLength,
    mergeQueue: progress.mergeQueueLength,
    waitingOnTools: progress.l1WaitingOnTools + progress.mergesWaitingOnTools,
    pending: progress.pending,
    summaries: progress.summaryCounts,
    // null when the debt report couldn't count one of them (see debtError)
    quarantines: debt.compressionQuarantineCount === null || debt.mergeQuarantineCount === null
      ? null
      : debt.compressionQuarantineCount + debt.mergeQuarantineCount,
    pendingChunks: debt.pendingChunks,
    mergesUnpicked: strategy.mergesUnpicked,
    frontier: debt.unmergedFrontier,
    tools: tools.length,
    ...(debt.error !== undefined ? { debtError: debt.error } : {}),
  };
};

console.log(JSON.stringify({ event: 'start', runs: strategy.runs, ...compact() }));
let completed = false;
let final = compact();
let tickError: string | undefined;
const drained = (c: ReturnType<typeof compact>): boolean =>
  !c.pending && c.l1Queue === 0 && c.mergeQueue === 0 && c.waitingOnTools === 0 && c.pendingChunks === 0 && !c.mergesUnpicked;
const onlyWaiting = (c: ReturnType<typeof compact>): boolean =>
  !c.pending && c.l1Queue === 0 && c.mergeQueue === 0 && c.waitingOnTools > 0;
let waiting = false;
try {
  for (let step = 1; step <= maxSteps; step++) {
    const before = compact();
    // A store whose debt it can't read is one it can't tell is drained, so
    // stop here rather than spend provider calls on it.
    if (before.debtError !== undefined) break;
    if (drained(before)) {
      completed = true;
      break;
    }
    try {
      await manager.tick();
    } catch (error) {
      tickError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      break;
    }
    const after = compact();
    console.log(JSON.stringify({ event: 'step', step, ...after }));
    if (onlyWaiting(after) && JSON.stringify(after) === JSON.stringify(before)) {
      waiting = true;
      break;
    }
  }
  final = compact();
  if (!completed && tickError === undefined && final.debtError === undefined && drained(final)) completed = true;
} finally {
  manager.close();
}
const stopped = completed ? 'drained' : tickError !== undefined ? 'tick-error' : final.debtError !== undefined ? 'debt-unreadable'
  : waiting ? 'waiting-on-tools' : 'max-steps';
console.log(JSON.stringify({ event: 'finish', completed, stopped, ...final, ...(tickError !== undefined ? { tickError } : {}) }));
if (stopped === 'waiting-on-tools') {
  console.error(`not drained (waiting-on-tools): ${final.waitingOnTools} chunks and merges wait on the resident's tool definitions; ` +
    'run the drain again with --tools-log=<a log of its requests>');
} else if (!completed) {
  console.error(`not drained (${stopped}): run the drain again with the same flags, leaving out --clear-merge-quarantine, which goes on from the store as it stands` +
    (stopped === 'debt-unreadable' ? ', once the debt report can be read' : ''));
  console.error('restarting the resident instead: it finishes by its own rules and can leave strays the audit lists; ' +
    'run the drain again first to land the plan as projected');
}
if (final.quarantines === null || final.quarantines > 0) {
  console.error(`${final.quarantines === null ? 'quarantines not counted' : `${final.quarantines} quarantined`}: ` +
    'compression and merge quarantines together; audit-topology names each one beside a stray, and a merge\'s quarantine clears with --clear-merge-quarantine=<key>');
}
// A last report with an error fails, and so does one whose quarantines it
// couldn't count (null).
if (!completed || final.quarantines !== 0 || final.debtError !== undefined) process.exit(1);
