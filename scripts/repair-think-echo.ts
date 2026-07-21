/**
 * Repair pass for the think/skip_reply input-echo (see scan-think-echo.ts).
 *
 * For every tool_result paired to a `think`/`skip_reply` tool_use whose data
 * carries the pre-af-0.6.7 echo field (`content` / `reason`), rewrite the
 * result to exactly what af >=0.6.7 (3cd3689) would have written: the same
 * data object WITHOUT the echo field. Nothing else in the message is touched;
 * the agent's text stays exactly once, in the tool_use input. Edits go
 * through ContextManager.editMessage() — the first-class event-sourced edit
 * op (bodyGroup shards are refused by the store; the scanner flags those).
 *
 * DRY-RUN BY DEFAULT — prints what it would change. Pass --apply to edit.
 * Validate on a COPY first: repair the copy, re-run scan-think-echo (expect
 * 0 hits), spot-check a repaired message, then apply to the real store with
 * the agent STOPPED. Expect a one-time KV re-warm on the edited prefix.
 *
 * Usage:
 *   bun scripts/repair-think-echo.ts <store-path> [--apply]
 */

import { existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const ECHO_TOOLS: Record<string, string> = {
  think: 'content',
  skip_reply: 'reason',
};

/** Parse possibly nested-stringified JSON, remembering the nesting depth so
 *  the repaired value can be re-encoded identically. */
function parseWithDepth(raw: string): { data: Record<string, unknown>; depth: number } | null {
  let value: unknown = raw;
  let depth = 0;
  while (typeof value === 'string' && depth < 3) {
    try {
      value = JSON.parse(value);
      depth++;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { data: value as Record<string, unknown>, depth }
    : null;
}

function encodeWithDepth(data: unknown, depth: number): string {
  let out: unknown = data;
  for (let i = 0; i < depth; i++) out = JSON.stringify(out);
  return out as string;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: repair-think-echo <store-path> [--apply]');
    process.exit(1);
  }
  const storePath = args[0]!;
  const apply = args.includes('--apply');

  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    process.exit(1);
  }

  const strategy = new AutobiographicalStrategy({
    compressionModel: 'repair-only-never-called',
    targetChunkTokens: 1_000_000,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
  });
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: { complete: async () => ({ content: [{ type: 'text', text: '' }] }) } as never,
  });

  const messages = manager.getAllMessages();

  const useById = new Map<string, { tool: string }>();
  for (const m of messages) {
    for (const block of m.content as ContentBlock[]) {
      const b = block as { type?: string; id?: string; name?: string };
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string' && b.name in ECHO_TOOLS) {
        useById.set(b.id, { tool: b.name });
      }
    }
  }

  let repaired = 0;
  let skippedShards = 0;
  let echoBytesRemoved = 0;

  for (const m of messages) {
    let changed = false;
    const newContent = (m.content as ContentBlock[]).map((block) => {
      const b = block as {
        type?: string; tool_use_id?: string; toolUseId?: string; content?: unknown;
      };
      const pairId = typeof b.toolUseId === 'string' ? b.toolUseId : b.tool_use_id;
      if (b.type !== 'tool_result' || typeof pairId !== 'string') return block;
      const use = useById.get(pairId);
      if (!use) return block;
      if (typeof b.content !== 'string') return block; // scanner reported none of these on fable; bail conservatively
      const parsed = parseWithDepth(b.content);
      if (!parsed) return block;
      const field = ECHO_TOOLS[use.tool]!;
      const echoValue = parsed.data[field];
      if (typeof echoValue !== 'string' || echoValue.length === 0) return block;

      const repairedData = { ...parsed.data };
      delete repairedData[field];
      changed = true;
      echoBytesRemoved += Buffer.byteLength(echoValue, 'utf8');
      return { ...block, content: encodeWithDepth(repairedData, parsed.depth) } as ContentBlock;
    });

    if (!changed) continue;

    if (m.bodyGroupId) {
      skippedShards++;
      console.warn(`SKIP shard msg ${m.id} (bodyGroup ${m.bodyGroupId}) — needs group-aware handling`);
      continue;
    }

    repaired++;
    if (apply) {
      manager.editMessage(m.id, newContent);
    } else {
      console.log(`would repair msg ${m.id} (${m.participant})`);
    }
  }

  console.log(`\n=== repair-think-echo ${apply ? 'APPLIED' : 'DRY-RUN'} ===`);
  console.log(`Store: ${storePath}`);
  console.log(`Messages ${apply ? 'repaired' : 'to repair'}: ${repaired}`);
  console.log(`Echo bytes removed: ${echoBytesRemoved}`);
  if (skippedShards > 0) console.log(`Skipped bodyGroup shards: ${skippedShards} (unrepaired!)`);
  if (!apply && repaired > 0) console.log('Dry-run only — re-run with --apply to edit.');

  manager.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
