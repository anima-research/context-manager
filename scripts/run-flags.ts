import { DEFAULT_RUNS_CONFIG, type RepairRunsConfig } from '../src/repair/topology.js';

export const RUNS_USAGE =
  '    --merge-threshold <n>        mergeThreshold (6)\n' +
  '    --merge-max-span <n>         mergeMaxSourceSpanMessages (1500)\n' +
  '    --merge-hold <id,id,…>       mergeHoldSummaryIds (none)\n' +
  '    --no-speculative-production  for a resident without adaptive resolution: its merge check reads L1 and L2 only\n' +
  '                                 (speculativeProduction off; adaptive residents, connectome-host\'s default, have it on)';

export const RUN_VALUE_FLAGS = ['--merge-threshold', '--merge-max-span', '--merge-hold'] as const;

export function flagValue(args: readonly string[], name: string): string | undefined | { error: string } {
  if (args.filter((a) => a === name || a.startsWith(`${name}=`)).length > 1) return { error: `${name} is given more than once` };
  const at = args.indexOf(name);
  const raw = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  if (at < 0 && raw === undefined) return undefined;
  if (raw === undefined || raw.trim() === '' || (at >= 0 && raw.startsWith('--'))) return { error: `${name} needs a value` };
  return raw;
}

export function positionalArg(args: readonly string[], valueFlags: readonly string[]): string | undefined | { error: string } {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) { i++; continue; }
    if (!a.startsWith('--')) found.push(a);
  }
  if (found.length > 1) return { error: `one store path is read, but ${found.length} arguments are no flag or flag value: ${found.join(' ')}` };
  return found[0];
}

export function runsFromArgs(args: readonly string[]): RepairRunsConfig | { error: string } {
  const count = (name: string, fallback: number): number | { error: string } => {
    const raw = flagValue(args, name);
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string') return raw;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : { error: `${name} must be a whole number, got ${raw}` };
  };
  const mergeThreshold = count('--merge-threshold', DEFAULT_RUNS_CONFIG.mergeThreshold);
  const mergeMaxSourceSpanMessages = count('--merge-max-span', DEFAULT_RUNS_CONFIG.mergeMaxSourceSpanMessages);
  if (typeof mergeThreshold !== 'number') return mergeThreshold;
  if (typeof mergeMaxSourceSpanMessages !== 'number') return mergeMaxSourceSpanMessages;
  const holds = flagValue(args, '--merge-hold');
  if (typeof holds === 'object') return holds;
  if (args.some((a) => a.startsWith('--no-speculative-production='))) return { error: '--no-speculative-production takes no value' };
  if (args.filter((a) => a === '--no-speculative-production').length > 1) return { error: '--no-speculative-production is given more than once' };
  return {
    mergeThreshold,
    mergeMaxSourceSpanMessages,
    mergeHoldSummaryIds: (holds ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    speculativeProduction: !args.includes('--no-speculative-production'),
  };
}

export function runsLine(runs: RepairRunsConfig): string {
  return `run settings the stray rule read: mergeThreshold ${runs.mergeThreshold}, mergeMaxSourceSpanMessages ${runs.mergeMaxSourceSpanMessages}, ` +
    `mergeHoldSummaryIds ${runs.mergeHoldSummaryIds.length ? runs.mergeHoldSummaryIds.join(',') : 'none'}, ` +
    `speculativeProduction ${runs.speculativeProduction ? 'on' : 'off'} (pass the resident's own; see --help)`;
}
