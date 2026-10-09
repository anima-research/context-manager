#!/usr/bin/env node
/**
 * context-manager-migrate — folding-strategy migration CLI (kv-stable ⇄
 * kv-unified). See folding-migration.ts for the underlying semantics.
 *
 *   context-manager-migrate validate   --store <path> [--ns <namespace>] [--config <file>] [--json]
 *   context-manager-migrate to-unified --store <path> --accepted-at <epoch-ms> [--ns <namespace>]
 *                                      [--config <file>] [--apply] [--overwrite] [--json]
 *   context-manager-migrate to-stable  --store <path> [--ns <namespace>] [--apply] [--json]
 *
 * Everything is a dry run unless --apply is passed. `to-stable` and the
 * dry-run paths never open a ContextManager; `validate` and `to-unified` do,
 * which runs the strategy's standard on-load canonicalization (the same
 * repairs any agent restart performs) — run against a copy first.
 */

import { existsSync, readFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { AutobiographicalOptions } from '../types/strategy.js';
import {
  discoverAutobioNamespaces,
  migrateToStable,
  migrateToUnified,
  readFlavor,
  validateStoreForKvUnified,
} from './folding-migration.js';

interface Args {
  command: string;
  store: string;
  ns?: string;
  config?: string;
  acceptedAt?: number;
  apply: boolean;
  overwrite: boolean;
  json: boolean;
}

function usage(exitCode: number): never {
  console.error(
    [
      'Usage:',
      '  context-manager-migrate validate   --store <path> [--ns <namespace>] [--config <file>] [--json]',
      '  context-manager-migrate to-unified --store <path> --accepted-at <epoch-ms> [--ns <namespace>]',
      '                                     [--config <file>] [--apply] [--overwrite] [--json]',
      '  context-manager-migrate to-stable  --store <path> [--ns <namespace>] [--apply] [--json]',
      '',
      'Dry-run by default; --apply writes. --config is the agent\'s',
      'AutobiographicalOptions as JSON (chunking/window settings should match',
      'the agent that owns the store). --accepted-at is the timestamp stamped',
      'on the synthesized receipt (e.g. `--accepted-at $(date +%s%3N)`) —',
      'explicit so the migration is reproducible.',
      '',
      'validate and to-unified open the store through the strategy, which runs',
      'its standard on-load repairs (identical to any agent restart). Run',
      'against a copy of a live store, never the original in place.',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!command || !['validate', 'to-unified', 'to-stable'].includes(command)) usage(2);
  const args: Args = { command, store: '', apply: false, overwrite: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) usage(2);
      return v;
    };
    switch (a) {
      case '--store': args.store = next(); break;
      case '--ns': args.ns = next(); break;
      case '--config': args.config = next(); break;
      case '--accepted-at': args.acceptedAt = Number(next()); break;
      case '--apply': args.apply = true; break;
      case '--overwrite': args.overwrite = true; break;
      case '--json': args.json = true; break;
      case '--help': case '-h': usage(0); break;
      default:
        console.error(`Unknown argument: ${a}`);
        usage(2);
    }
  }
  if (!args.store) usage(2);
  return args;
}

function loadConfig(path: string | undefined): AutobiographicalOptions | undefined {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--config ${path}: expected a JSON object of AutobiographicalOptions`);
  }
  return parsed as AutobiographicalOptions;
}

/** Resolve the namespace: explicit --ns wins; otherwise discover, and refuse
 *  to guess when the store carries more than one. */
function resolveNamespace(storePath: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  const store = JsStore.open({ path: storePath });
  try {
    const found = discoverAutobioNamespaces(store);
    if (found.length === 1) return found[0];
    if (found.length === 0) {
      console.error(
        'No autobiographical state found in this store (no */autobio:summaries slot). ' +
          'Pass --ns explicitly if the namespace has produced no summaries yet.',
      );
      process.exit(1);
    }
    console.error(
      `Store carries ${found.length} autobiographical namespaces — pass --ns to pick one:\n` +
        found.map((n) => `  ${n}`).join('\n'),
    );
    process.exit(1);
  } finally {
    store.close();
  }
}

function emit(json: boolean, data: unknown, human: string): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(human);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.store)) {
    console.error(`Store path does not exist: ${args.store}`);
    process.exit(1);
  }
  const namespace = resolveNamespace(args.store, args.ns);
  const config = loadConfig(args.config);

  switch (args.command) {
    case 'validate': {
      const result = await validateStoreForKvUnified({ path: args.store, namespace, config });
      const lines = [
        `namespace: ${result.namespace}`,
        result.strictIssues.length === 0
          ? 'strict forest: CLEAN — no structural issues'
          : `strict forest: ${result.strictIssues.length} issue(s):`,
        ...result.strictIssues.map(
          (i) => `  [${i.code}] ${i.message}` +
            (i.summaryIds.length ? ` (summaries: ${i.summaryIds.slice(0, 5).join(', ')}${i.summaryIds.length > 5 ? ', …' : ''})` : ''),
        ),
        ...result.outcomes.map(
          (o) =>
            `policy ${o.policy}: ${o.ok ? 'OK' : `rejected (${o.issues.length} issue(s))`}` +
            (o.solverLimit ? ` [forest built; validation solve stopped early: ${o.solverLimit}]` : ''),
        ),
        result.recommendation
          ? `recommendation: migrate with policy "${result.recommendation}"`
          : 'recommendation: NONE — no treeification policy canonicalizes this store; repair summary state first',
      ];
      emit(args.json, result, lines.join('\n'));
      if (!result.recommendation) process.exit(3);
      break;
    }
    case 'to-unified': {
      if (args.acceptedAt === undefined || !Number.isFinite(args.acceptedAt)) {
        console.error('to-unified requires --accepted-at <epoch-ms> (explicit for reproducibility).');
        process.exit(2);
      }
      const result = await migrateToUnified({
        path: args.store,
        namespace,
        config,
        acceptedAt: args.acceptedAt,
        apply: args.apply,
        overwrite: args.overwrite,
      });
      if (result.refusedExistingChain) {
        emit(
          args.json,
          result,
          `REFUSED: ${namespace} already carries a receipt chain (head sequence ` +
            `${result.refusedExistingChain.headSequence}, ${result.refusedExistingChain.leafCount} leaves). ` +
            'If it is stale (left behind by a previous flip away from kv-unified), re-run with --overwrite.',
        );
        process.exit(4);
      }
      const lines = [
        `namespace: ${result.namespace}`,
        `presentation: ${result.messageCount} leaves, ${result.foldedCount} folded`,
        ...result.warnings.map(
          (w) =>
            `  warning: ${w.messageId} resolution L${w.requestedLevel} has no summary at that level; ` +
            `recorded L${w.usedLevel}`,
        ),
        `receipt head: ${result.receiptHeadHash}`,
        result.applied
          ? 'APPLIED — receipt chain written. Flip the agent config to foldingStrategy "kv-unified" to complete the migration.'
          : 'DRY RUN — nothing written. Re-run with --apply to write the receipt chain.',
      ];
      emit(args.json, result, lines.join('\n'));
      break;
    }
    case 'to-stable': {
      const store = JsStore.open({ path: args.store });
      try {
        const flavorBefore = readFlavor(store, namespace);
        const result = migrateToStable({ store, namespace, apply: args.apply });
        const lines = [
          `namespace: ${result.namespace}`,
          result.cleared === null
            ? 'receipt slot already empty — nothing to do'
            : `receipt chain: head sequence ${result.cleared.headSequence}, ${result.cleared.leafCount} leaves` +
              (flavorBefore.hasResolutions
                ? ' (resolutions frontier present; kv-stable will seed from it)'
                : ' (no resolutions frontier — kv-stable will bootstrap)'),
          result.cleared === null
            ? ''
            : result.applied
              ? 'APPLIED — receipt chain cleared (recoverable from chronicle state history). Flip the agent config to complete the migration.'
              : 'DRY RUN — nothing written. Re-run with --apply to clear the receipt chain.',
        ].filter(Boolean);
        emit(args.json, result, lines.join('\n'));
      } finally {
        store.close();
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
