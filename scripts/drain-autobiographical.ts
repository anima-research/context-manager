/**
 * Offline autobiographical compression drain for a copied Chronicle store.
 * This performs real provider calls and writes summaries; --apply is required.
 * It never starts an agent inference or connects MCPL modules.
 *
 * Usage:
 *   drain-autobiographical <copied-store> <namespace> --apply \
 *     --model=claude-fable-5 --participant=fable [--max-steps=200]
 */

import {
  AnthropicAdapter,
  Membrane,
  NativeFormatter,
  type ToolDefinition,
} from '@animalabs/membrane';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

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
const clearMergeQuarantineKeys = args
  .filter((arg) => arg.startsWith('--clear-merge-quarantine='))
  .map((arg) => arg.slice('--clear-merge-quarantine='.length))
  .filter(Boolean);

if (!storePath || !namespace || !model || !participant || !apply) {
  console.error(
    'usage: drain-autobiographical <copied-store> <namespace> --apply ' +
      '--model=<resident-model> --participant=<resident> [--max-steps=200]',
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
const strategy = new AutobiographicalStrategy({
  adaptiveResolution: true,
  hierarchical: true,
  speculativeProduction: true,
  autoTickOnNewMessage: false,
  headWindowTokens: 4_000,
  recentWindowTokens: 100_000,
  maxMessageTokens: 10_000,
  mergeThreshold: 6,
  maxSpeculativeL1s: 36,
  compressionModel: model,
  summaryParticipant: participant,
  enforceBudget: true,
});
const tools = toolsLog ? latestToolsFromAnthropicLog(toolsLog) : [];

const manager = await ContextManager.open({
  path: storePath,
  namespace,
  strategy,
  membrane,
});
if (tools.length > 0) manager.setToolDefinitions(tools);
for (const key of clearMergeQuarantineKeys) strategy.clearMergeQuarantine(key);

const compact = () => {
  const progress = strategy.getProgressSnapshot();
  const debt = strategy.getCompressionDebt();
  return {
    l1Queue: progress.l1QueueLength,
    mergeQueue: progress.mergeQueueLength,
    pending: progress.pending,
    summaries: progress.summaryCounts,
    quarantines: debt.compressionQuarantineCount + debt.mergeQuarantineCount,
    pendingChunks: debt.pendingChunks,
    frontier: debt.unmergedFrontier,
    tools: tools.length,
  };
};

console.log(JSON.stringify({ event: 'start', ...compact() }));
let completed = false;
let final = compact();
try {
  for (let step = 1; step <= maxSteps; step++) {
    const before = compact();
    if (
      !before.pending &&
      before.l1Queue === 0 &&
      before.mergeQueue === 0 &&
      before.pendingChunks === 0
    ) {
      completed = true;
      break;
    }
    await manager.tick();
    console.log(JSON.stringify({ event: 'step', step, ...compact() }));
  }
  final = compact();
} finally {
  manager.close();
}
console.log(JSON.stringify({ event: 'finish', completed, ...final }));
if (!completed || final.quarantines > 0) process.exit(1);

function latestToolsFromAnthropicLog(path: string): ToolDefinition[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let bytes = 4 * 1024 * 1024; bytes <= 64 * 1024 * 1024; bytes *= 2) {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      if (size > length) lines.shift(); // discard a partial first record
      for (let index = lines.length - 1; index >= 0; index--) {
        let row: {
          type?: unknown;
          kind?: unknown;
          rawRequest?: { tools?: unknown };
        };
        try { row = JSON.parse(lines[index]!); } catch { continue; }
        if (row.type !== 'call' || row.kind !== 'stream' || !Array.isArray(row.rawRequest?.tools)) {
          continue;
        }
        const normalized: ToolDefinition[] = [];
        for (const candidate of row.rawRequest.tools) {
          if (!candidate || typeof candidate !== 'object') continue;
          const raw = candidate as {
            name?: unknown;
            description?: unknown;
            input_schema?: unknown;
          };
          if (
            typeof raw.name !== 'string' ||
            typeof raw.description !== 'string' ||
            !raw.input_schema ||
            typeof raw.input_schema !== 'object'
          ) continue;
          normalized.push({
            name: raw.name,
            description: raw.description,
            inputSchema: raw.input_schema as ToolDefinition['inputSchema'],
          });
        }
        if (normalized.length > 0) return normalized;
      }
      if (length === size) break;
    }
  } finally {
    closeSync(fd);
  }
  throw new Error(`no stream-call tool definition found in the last 64 MiB of ${path}`);
}
