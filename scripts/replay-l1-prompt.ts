/**
 * Re-run ONE L1 compression with the new-style prompt (head window present,
 * no system prompt), against the same opus-4-7 model. Build the prompt from
 * the dumps in /tmp/llr-faith/ and the original llr.json — no chronicle
 * needed.
 *
 * Usage:
 *   node dist/scripts/replay-l1-prompt.js <L1-N> [--llr <path>] [--out <dir>]
 *
 * Reads:
 *   /tmp/llr-faith/l1/L1-{0..N}.md  (prior recall pairs + this L1's source)
 *   <llr-json>                       (for the first 2 messages = head)
 *
 * Calls Anthropic via membrane with the rebuilt prompt and saves both the
 * prompt and the new response under <out>/L1-N/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// Use the Anthropic SDK that's bundled with membrane (we know it's there).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AnthropicMod = require('/Users/antra/connectome-local/membrane/node_modules/@anthropic-ai/sdk');
const Anthropic = AnthropicMod.default ?? AnthropicMod.Anthropic ?? AnthropicMod;

const COMPRESSION_MARKER =
  'System: You will soon form a new memory, get ready. ' +
  'The messages that follow are the slice of recent experience you are ' +
  'about to compress. After them, write the memory in your own voice.';

function formatReadingChunkInstruction(totalTokens: number, targetTokens = 2000): string {
  return (
    `You have just been reading a substantial body of text — approximately ` +
    `${totalTokens} tokens total in this piece, of which what you just read ` +
    `is a portion. Earlier portions are in your memory above as your prior ` +
    `reflections; what comes after, you have not yet read.\n\n` +
    `Reflect on this reading: what was it like? What did you learn? What ` +
    `stood out? Be substantive — name the specific claims, frameworks, ` +
    `people, dates, and phrases that struck you. What is now in your ` +
    `understanding that wasn't before you read this portion?\n\n` +
    `Speak in your own voice as the one reading. Target ~${targetTokens} ` +
    `tokens. Output only the body of your reflection — no preamble.`
  );
}

function parseDump(path: string): { summary: string; source: string } {
  const text = readFileSync(path, 'utf8');
  const sumMatch = text.match(/## SUMMARY[^\n]*\n+([\s\S]*?)(?=\n## SOURCE)/);
  const srcMatch = text.match(/## SOURCE CONTENT[^\n]*\n+([\s\S]*)/);
  return {
    summary: sumMatch ? sumMatch[1].trim() : '',
    source: srcMatch ? srcMatch[1].trim() : '',
  };
}

function parseArgs(argv: string[]): {
  target: string;
  llrPath: string;
  outDir: string;
  chain: boolean;
} {
  const positionals: string[] = [];
  let llrPath = '/Users/antra/connectome-local/llr.json';
  let outDir = '/tmp/l1-replay';
  let chain = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--llr') llrPath = argv[++i];
    else if (a === '--out') outDir = argv[++i];
    else if (a === '--chain') chain = true;
    else positionals.push(a);
  }
  if (positionals.length < 1) {
    throw new Error(
      'Usage: replay-l1-prompt <L1-N> [--llr <path>] [--out <dir>] [--chain]\n' +
        '       --chain: use prior L1 replay outputs from <outDir>/L1-K/new-response.md' +
        ' instead of v2 dumps. Run L1-N=1..M sequentially to build a clean chain.'
    );
  }
  return { target: positionals[0], llrPath, outDir, chain };
}

async function main() {
  const { target, llrPath, outDir, chain } = parseArgs(process.argv.slice(2));
  const m = target.match(/^L1-(\d+)$/);
  if (!m) {
    console.error(`Bad target: ${target} (expected L1-N)`);
    process.exit(1);
  }
  const targetIdx = parseInt(m[1], 10);

  // Load original llr.json for head messages
  if (!existsSync(llrPath)) {
    console.error(`llr.json not found at ${llrPath}`);
    process.exit(1);
  }
  const llr = JSON.parse(readFileSync(llrPath, 'utf8')) as {
    model?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string }> }>;
  };

  function asText(c: typeof llr.messages[number]['content']): string {
    if (typeof c === 'string') return c;
    return c
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? String(b.text ?? '') : ''))
      .join('');
  }

  // Head = first 2 messages (the chat openers), regardless of the strategy's
  // headWindowTokens setting at original-run time. ~30 tokens combined.
  const headMessages = llr.messages.slice(0, 2).map((mm) => ({
    role: mm.role,
    text: asText(mm.content),
  }));

  // Prior L1 bodies. Two modes:
  //   default: use V2's dumps (the original drifted ones)
  //   --chain: use this script's prior replay outputs (clean chain)
  //
  // L1-0 always comes from the V2 dump — we don't replay L1-0 because its
  // chunk includes the chat opener, so it's already correct. (We could
  // replay it too for true purity but it doesn't help diagnose drift.)
  const priors: Array<{ id: string; body: string }> = [];
  for (let i = 0; i < targetIdx; i++) {
    let body: string;
    if (chain && i > 0) {
      const replayPath = `${outDir}/L1-${i}/new-response.md`;
      if (!existsSync(replayPath)) {
        console.error(
          `--chain mode: missing prior replay at ${replayPath}\n` +
            `Run \`node dist/replay-l1-prompt.js L1-${i} --chain\` first.`
        );
        process.exit(1);
      }
      body = readFileSync(replayPath, 'utf8').trim();
    } else {
      const path = `/tmp/llr-faith/l1/L1-${i}.md`;
      if (!existsSync(path)) {
        console.error(`Missing dump: ${path}`);
        process.exit(1);
      }
      body = parseDump(path).summary;
    }
    priors.push({ id: `L1-${i}`, body });
  }
  const targetPath = `/tmp/llr-faith/l1/L1-${targetIdx}.md`;
  if (!existsSync(targetPath)) {
    console.error(`Missing target dump: ${targetPath}`);
    process.exit(1);
  }
  const { source: chunkSource, summary: originalOutput } = parseDump(targetPath);

  // Approximate the full-doc tokens for the doc-chunk instruction.
  // From llr.json: message [2] is the doc.
  let originalDocTokens = 0;
  if (llr.messages[2]) {
    originalDocTokens = Math.ceil(asText(llr.messages[2].content).length / 4);
  }

  // ---- Build the prompt (new structure) ----
  // Each message has explicit role (user/assistant) — what the API expects.
  type ApiMsg = { role: 'user' | 'assistant'; text: string; description: string };
  const msgs: ApiMsg[] = [];

  // 1. HEAD (raw, always present)
  for (const h of headMessages) {
    msgs.push({ role: h.role, text: h.text, description: `HEAD ${h.role}` });
  }

  // 2. Prior L1 recall pairs (in source order). The CM-Q goes under
  // user role with a [CM] prefix to mark it as a system question
  // (matches the strategy's behavior).
  for (const p of priors) {
    msgs.push({ role: 'user', text: `[CM] Recall memory ${p.id}.`, description: `RECALL-Q ${p.id}` });
    msgs.push({ role: 'assistant', text: p.body, description: `RECALL-A ${p.id}` });
  }

  // 3. Compression marker (user role)
  msgs.push({ role: 'user', text: COMPRESSION_MARKER, description: 'MARKER' });

  // 4. Chunk source content (user role)
  msgs.push({ role: 'user', text: chunkSource, description: 'CHUNK' });

  // 5. Doc instruction (user role)
  msgs.push({
    role: 'user',
    text: formatReadingChunkInstruction(originalDocTokens),
    description: 'INSTRUCTION',
  });

  // Collapse consecutive same-role messages (Anthropic API requires alternation)
  type Collapsed = { role: 'user' | 'assistant'; text: string };
  const collapsed: Collapsed[] = [];
  for (const m of msgs) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === m.role) {
      last.text = last.text + '\n\n' + m.text;
    } else {
      collapsed.push({ role: m.role, text: m.text });
    }
  }

  const totalChars = collapsed.reduce((acc, m) => acc + m.text.length, 0);
  console.log(
    `Built prompt: ${msgs.length} pre-collapse messages → ${collapsed.length} after collapse, ` +
      `~${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`
  );

  // ---- Save prompt as a markdown file for inspection ----
  mkdirSync(`${outDir}/${target}`, { recursive: true });
  const promptDump: string[] = [];
  promptDump.push(`# New-style prompt for ${target}\n`);
  promptDump.push(`(no system prompt; head window always present; no filtering)\n`);
  promptDump.push(`Prior L1s: ${priors.length}  Head messages: ${headMessages.length}  Chunk chars: ${chunkSource.length}\n`);
  promptDump.push(`Total messages (pre-collapse): ${msgs.length}  (post-collapse): ${collapsed.length}\n`);
  promptDump.push('\n---\n\n## Pre-collapse messages\n');
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    promptDump.push(`\n### [${i}] role=${m.role} (${m.description}) — ${m.text.length} chars`);
    promptDump.push('');
    promptDump.push(m.text);
    promptDump.push('\n---');
  }
  writeFileSync(`${outDir}/${target}/prompt.md`, promptDump.join('\n'));
  console.log(`Wrote prompt → ${outDir}/${target}/prompt.md`);

  // ---- Call Anthropic directly (no system prompt, no stop_sequences, no extra processing) ----
  const apiKey = process.env.CONNECTOME_LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('No CONNECTOME_LLM_API_KEY / ANTHROPIC_API_KEY in env — prompt saved but not run.');
    process.exit(0);
  }
  const model = llr.model ?? 'claude-opus-4-7';
  console.log(`Calling ${model} directly via Anthropic SDK (this may take 30-90s)...`);
  const client = new Anthropic({ apiKey });
  const callStart = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 3000,
    messages: collapsed.map((m) => ({ role: m.role, content: m.text })),
  });
  const latency = Date.now() - callStart;
  const newOutput = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

  writeFileSync(`${outDir}/${target}/new-response.md`, newOutput);
  writeFileSync(`${outDir}/${target}/old-response.md`, originalOutput);
  console.log(`Latency: ${(latency / 1000).toFixed(1)}s`);
  console.log(`New output: ${newOutput.length} chars (~${Math.ceil(newOutput.length / 4)} tokens)`);
  console.log(`Old output: ${originalOutput.length} chars (~${Math.ceil(originalOutput.length / 4)} tokens)`);
  console.log(`\nNew response saved → ${outDir}/${target}/new-response.md`);
  console.log(`Old response saved → ${outDir}/${target}/old-response.md`);
  console.log(`\n=== NEW RESPONSE (first 600 chars) ===\n${newOutput.slice(0, 600)}`);
  console.log(`\n=== OLD RESPONSE (first 600 chars) ===\n${originalOutput.slice(0, 600)}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
