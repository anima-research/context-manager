/**
 * Export a real chronicle store as PickerInputs JSON for the best-fit
 * playground. Reads the AutobiographicalStrategy's messages + summaries +
 * resolutions (same access pattern as inspect-store) and assembles the
 * PickerInputs shape the V2 solver consumes — then runs a sanity solve so we
 * know the data round-trips end-to-end before the browser ever loads it.
 *
 * Usage:
 *   node dist/scripts/export-picker-inputs.js <store-path> [--out <file.json>] [--at <iso8601>]
 *   node dist/scripts/export-picker-inputs.js ../../llr-migrated --out playground/data/llr.json
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import {
  SummaryTree,
  planControlledFrontier,
  type PickerInputs,
  type PickerChunk,
} from '../src/adaptive/index.js';
import type { SummaryEntry } from '../src/types/strategy.js';

function makeMockMembrane() {
  return { complete: async () => ({ content: [{ type: 'text', text: '[mock]' }] }) };
}

/** Rough token estimate per stored message (mirrors message-store's model). */
function estimateTokens(msg: { content?: unknown[] }): number {
  let t = 0;
  for (const block of (msg.content ?? []) as Array<Record<string, unknown>>) {
    const k = block.type;
    if (k === 'text') t += Math.ceil(String(block.text ?? '').length / 4);
    else if (k === 'thinking') t += Math.ceil(String(block.thinking ?? '').length / 4);
    else if (k === 'tool_use') t += Math.ceil(JSON.stringify(block.input ?? {}).length / 4) + 20;
    else if (k === 'tool_result') {
      const c = block.content;
      t += typeof c === 'string' ? Math.ceil(c.length / 4) : 100;
    } else if (k === 'image') t += 1600;
    else t += 50;
  }
  return Math.max(t, 1);
}

async function main() {
  const args = process.argv.slice(2);
  const storePath = args[0];
  if (!storePath || !existsSync(storePath)) {
    console.error('Usage: export-picker-inputs <store-path> [--out <file.json>]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : 'playground/data/chronicle.json';
  const nsIdx = args.indexOf('--ns');
  const namespace = nsIdx >= 0 ? args[nsIdx + 1] : undefined;
  const atIdx = args.indexOf('--at');
  const atRaw = atIdx >= 0 ? args[atIdx + 1] : undefined;
  const at = atRaw === undefined ? undefined : Date.parse(atRaw);
  if (atRaw !== undefined && !Number.isFinite(at)) {
    throw new Error(`Invalid --at timestamp: ${atRaw}`);
  }

  // Match the deployment recipe so head/tail + msgCap line up with reality.
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    headWindowTokens: 4000,
    recentWindowTokens: 30000,
    maxMessageTokens: 10000,
    mergeThreshold: 6,
    compressionModel: 'claude-opus-4-6',
  });
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: makeMockMembrane() as never,
    ...(namespace ? { namespace } : {}),
  });

  const messages = manager.getAllMessages().filter((message) =>
    at === undefined || message.timestamp.getTime() <= at,
  );
  const summaries = (((strategy as unknown as { summaries: SummaryEntry[] }).summaries) ?? [])
    .filter((summary) => at === undefined || summary.created <= at);
  const liveChunks =
    ((strategy as unknown as {
      chunks: Array<{ messages: Array<{ id: string }>; summaryId?: string }>;
    }).chunks) ?? [];
  const resolutions =
    ((strategy as unknown as { resolutions: Map<string, number> }).resolutions) ?? new Map();

  // message id → covering L1 summary id. Match selectAdaptive exactly:
  // persisted chunk ownership wins; sourceIds are a first-match fallback for
  // repaired/boundary-drifted messages with no live chunk-ledger pointer.
  const l1Of = new Map<string, string>();
  for (const chunk of liveChunks) {
    if (!chunk.summaryId) continue;
    for (const message of chunk.messages) l1Of.set(message.id, chunk.summaryId);
  }
  for (const s of summaries) {
    if (s.level === 1 && s.sourceLevel === 0) {
      for (const mid of s.sourceIds) {
        if (!l1Of.has(mid)) l1Of.set(mid, s.id);
      }
    }
  }

  const chunks: PickerChunk[] = messages.map((msg, i) => ({
    id: msg.id,
    sequence: i,
    rawTokens: estimateTokens(msg as { content?: unknown[] }),
    // A present-day resolution snapshot is not historical state. Created-time
    // fixtures reconstruct their previous frontier from the request tape.
    currentResolution: at === undefined ? (resolutions.get(msg.id) ?? 0) : 0,
    lockedByAgent: false,
    bodyGroupId: (msg as { bodyGroupId?: string }).bodyGroupId,
    pinned: false,
    l1Id: l1Of.get(msg.id),
  }));

  const recallPairTokens = new Map<string, number>();
  for (const s of summaries) recallPairTokens.set(s.id, s.tokens + 20);

  const inputs: PickerInputs = {
    chunks,
    summaries: new Map(summaries.map((s) => [s.id, s])),
    recallPairTokens,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };

  // ---- Sanity solve on the real data (proves the path end-to-end) ----
  const newestSeq = chunks.length - 1;
  const tree = new SummaryTree(inputs);
  const rawTotal = chunks.reduce((a, c) => a + c.rawTokens, 0);
  const fPrev = new Map(chunks.map((c) => [c.id, c.currentResolution]));
  const budget = Math.round(rawTotal * 0.4);
  const solved = planControlledFrontier(inputs, tree, {
    previous: fPrev,
    foldAtTokens: budget,
    expandAtTokens: budget,
    targetTokens: budget,
    windowTokens: budget,
    rawZone: new Set(),
    now: newestSeq,
    mergeThreshold: 6,
  });
  const dist: Record<number, number> = {};
  for (const lvl of solved.resolutions.values()) dist[lvl] = (dist[lvl] ?? 0) + 1;

  console.log('=== export-picker-inputs ===');
  console.log(`store:        ${storePath}`);
  console.log(`messages:     ${messages.length}`);
  console.log(`summaries:    ${summaries.length}`);
  console.log(`raw tokens:   ${rawTotal}`);
  console.log(`sanity solve (kv-stable): budget=${budget} → tokens=${solved.tokens}, folded=${solved.folded}, escalated=${solved.escalated}`);
  console.log(`resolution distribution: ${JSON.stringify(dist)}`);

  // ---- Write the playground payload ----
  const payload = {
    meta: {
      store: storePath,
      messages: messages.length,
      summaries: summaries.length,
      rawTokens: rawTotal,
      ...(at === undefined ? {} : { at: new Date(at).toISOString(), resolutions: 'cleared' }),
    },
    newestSequence: newestSeq,
    chunks,
    summaries,
    recallPairTokens: [...recallPairTokens.entries()],
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload));
  console.log(`\nWrote PickerInputs payload → ${outPath} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);

  manager.close?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
