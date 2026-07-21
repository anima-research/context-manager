/**
 * Scan a chronicle store for think/skip_reply tool_results that echo the
 * agent's tool_use input back verbatim — the pre-af-0.6.7 behavior (fixed
 * forward by agent-framework 3cd3689, released v0.6.7).
 *
 * Why it matters: the echoed private thought is the model's reasoning as
 * plaintext, duplicated in the result block. Replayed in an empty-system
 * summarizer request together with a subsequent action cycle it
 * deterministically trips Anthropic's `reasoning_extraction` refusal
 * (validated by ablation on fable's stuck compression request, 2026-07-21,
 * context-manager#42) — and merge target expansion replays raw history
 * indefinitely, so the landmine does not age out. It also doubles the byte
 * footprint of every think/skip turn in the live window.
 *
 * The durable fix is a one-time store repair (remove the echo field from the
 * result data, exactly what af >=0.6.7 writes), not a replay-time code strip.
 * This scanner is the READ-ONLY first half: it inventories affected messages
 * and emits a work-list for the repair pass.
 *
 * ALWAYS RUN AGAINST A COPY of the store — ContextManager.open() performs
 * init-time migrations and will contend with a live agent's LOCK.
 *
 * Usage:
 *   bun scripts/scan-think-echo.ts <store-path> [--json <out.json>] [--ns <namespace>]
 */

import { existsSync, writeFileSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const ECHO_TOOLS: Record<string, string> = {
  think: 'content', // handleToolThink echoed input.content as data.content
  skip_reply: 'reason', // handleToolSkipReply echoed input.reason as data.reason
};

interface EchoHit {
  messageIndex: number;
  messageId: string;
  participant: string;
  tool: string;
  toolUseId: string;
  echoField: string;
  echoBytes: number;
  resultBytes: number;
  bodyGroupId?: string;
  exactMatch: boolean; // echo strictly equals the tool_use input field
}

function textOfResult(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text);
    return texts.length ? texts.join('') : null;
  }
  return null;
}

function parseResultData(raw: string): Record<string, unknown> | null {
  // Stored result content is JSON.stringify(data), occasionally double-encoded.
  let value: unknown = raw;
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: scan-think-echo <store-path> [--json <out.json>] [--ns <namespace>]');
    process.exit(1);
  }
  const storePath = args[0]!;
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
  const nsIdx = args.indexOf('--ns');
  const ns = nsIdx >= 0 ? args[nsIdx + 1] : undefined;

  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    process.exit(1);
  }

  const strategy = new AutobiographicalStrategy({
    compressionModel: 'scan-only-never-called',
    targetChunkTokens: 1_000_000,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
  });
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: { complete: async () => ({ content: [{ type: 'text', text: '' }] }) } as never,
    ...(ns ? { namespace: ns } : {}),
  });

  const messages = manager.getAllMessages();

  // Pass 1: index every echo-tool tool_use by id -> {tool, input}.
  const useById = new Map<string, { tool: string; input: Record<string, unknown> }>();
  for (const m of messages) {
    for (const block of m.content as ContentBlock[]) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
      if (!(b.name in ECHO_TOOLS)) continue;
      useById.set(b.id, {
        tool: b.name,
        input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>,
      });
    }
  }

  // Pass 2: find paired tool_results whose data carries the echo field.
  const hits: EchoHit[] = [];
  let orphanResults = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    for (const block of m.content as ContentBlock[]) {
      // Stored blocks are membrane-normalized: the pairing field is
      // `toolUseId` (camelCase); raw API imports may carry `tool_use_id`.
      const b = block as { type?: string; tool_use_id?: string; toolUseId?: string; content?: unknown };
      const pairId = typeof b.toolUseId === 'string' ? b.toolUseId : b.tool_use_id;
      if (b.type !== 'tool_result' || typeof pairId !== 'string') continue;
      const use = useById.get(pairId);
      if (!use) {
        orphanResults++;
        continue;
      }
      const raw = textOfResult(b.content);
      if (!raw) continue;
      const data = parseResultData(raw);
      if (!data) continue;
      const field = ECHO_TOOLS[use.tool]!;
      const echoValue = data[field];
      if (typeof echoValue !== 'string' || echoValue.length === 0) continue;
      const inputValue = use.input[field === 'content' ? 'content' : 'reason'];
      hits.push({
        messageIndex: i,
        messageId: m.id,
        participant: m.participant,
        tool: use.tool,
        toolUseId: pairId,
        echoField: field,
        echoBytes: Buffer.byteLength(echoValue, 'utf8'),
        resultBytes: Buffer.byteLength(raw, 'utf8'),
        ...(m.bodyGroupId ? { bodyGroupId: m.bodyGroupId } : {}),
        exactMatch: echoValue === inputValue,
      });
    }
  }

  const totalEcho = hits.reduce((n, h) => n + h.echoBytes, 0);
  const byTool = new Map<string, { count: number; bytes: number }>();
  for (const h of hits) {
    const t = byTool.get(h.tool) ?? { count: 0, bytes: 0 };
    t.count++;
    t.bytes += h.echoBytes;
    byTool.set(h.tool, t);
  }
  const inexact = hits.filter((h) => !h.exactMatch).length;
  const sharded = hits.filter((h) => h.bodyGroupId).length;

  console.log('=== think/skip_reply echo scan ===');
  console.log(`Store: ${storePath}`);
  console.log(`Messages scanned: ${messages.length}`);
  console.log(`Echoed results found: ${hits.length} (${totalEcho} echo bytes)`);
  for (const [tool, t] of byTool) {
    console.log(`  ${tool}: ${t.count} results, ${t.bytes} echo bytes`);
  }
  if (inexact > 0) {
    console.log(`  NOTE: ${inexact} echo(es) do not exactly match their tool_use input ` +
      `(inspect before repair — repair removes the field either way, but flag it).`);
  }
  if (sharded > 0) {
    console.log(`  WARNING: ${sharded} hit(s) are in bodyGroup shards — ` +
      `MessageStore.edit() refuses shards; repair needs the group-aware path.`);
  }
  if (orphanResults > 0) {
    console.log(`  (${orphanResults} tool_result(s) had no matching echo-tool tool_use in the loaded branch — ignored.)`);
  }
  if (hits.length > 0) {
    const first = hits[0]!;
    const last = hits[hits.length - 1]!;
    console.log(`Range: msg[${first.messageIndex}] (${first.messageId}) … msg[${last.messageIndex}] (${last.messageId})`);
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      store: storePath,
      scannedAt: new Date().toISOString(),
      messageCount: messages.length,
      totalEchoBytes: totalEcho,
      hits,
    }, null, 2));
    console.log(`Work-list written -> ${jsonOut}`);
  }

  manager.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
