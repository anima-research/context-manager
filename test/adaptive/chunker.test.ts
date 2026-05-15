import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkMessage, DEFAULT_CHUNKER_OPTIONS } from '../../src/adaptive/chunker.js';

// Use small thresholds for tests so we don't have to generate huge inputs.
const TINY = { chunkThreshold: 100, chunkSize: 40, charsPerToken: 1.0 } as const;

test('chunker: under threshold passes through as single shard', () => {
  const body = 'Hello world. This is a short message.';
  const result = chunkMessage(body, TINY);
  assert.equal(result.wasSharded, false);
  assert.equal(result.shards.length, 1);
  assert.equal(result.shards[0].content, body);
  assert.equal(result.shards[0].range.startByte, 0);
  assert.equal(result.shards[0].range.endByte, Buffer.byteLength(body, 'utf8'));
});

test('chunker: over threshold produces multiple shards with byte-faithful reassembly', () => {
  // 12 lines of ~20 chars each ≈ 240 chars total, target 40 chars/shard → ~6 shards
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) lines.push(`Line number ${i.toString().padStart(2, '0')} text`);
  const body = lines.join('\n');
  const result = chunkMessage(body, TINY);

  assert.equal(result.wasSharded, true);
  assert.ok(result.shards.length >= 3, `expected ≥3 shards, got ${result.shards.length}`);

  // Byte-faithful reassembly
  const reassembled = result.shards.map((s) => s.content).join('');
  assert.equal(reassembled, body, 'reassembled content must equal original byte-for-byte');

  // Indices sequential from 0
  for (let i = 0; i < result.shards.length; i++) {
    assert.equal(result.shards[i].index, i);
  }

  // Byte ranges contiguous and cover the entire body
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  let prevEnd = 0;
  for (const s of result.shards) {
    assert.equal(s.range.startByte, prevEnd, `gap or overlap at shard ${s.index}`);
    prevEnd = s.range.endByte;
  }
  assert.equal(prevEnd, bodyBytes, 'final endByte must equal body length');
});

test('chunker: deterministic — same input produces identical shards', () => {
  const body = 'a'.repeat(200) + '\n' + 'b'.repeat(200);
  const r1 = chunkMessage(body, TINY);
  const r2 = chunkMessage(body, TINY);
  assert.equal(r1.bodyGroupId, r2.bodyGroupId);
  assert.equal(r1.shards.length, r2.shards.length);
  for (let i = 0; i < r1.shards.length; i++) {
    assert.equal(r1.shards[i].sourceHash, r2.shards[i].sourceHash);
    assert.equal(r1.shards[i].content, r2.shards[i].content);
    assert.equal(r1.shards[i].range.startByte, r2.shards[i].range.startByte);
    assert.equal(r1.shards[i].range.endByte, r2.shards[i].range.endByte);
  }
});

test('chunker: prefers structural splits at markdown headings', () => {
  const body = [
    '## Section A',
    'Some text in section A. '.repeat(10),
    '',
    '## Section B',
    'Some text in section B. '.repeat(10),
    '',
    '## Section C',
    'Some text in section C. '.repeat(10),
  ].join('\n');

  // chunkSize chosen so ~one section fits per shard
  const result = chunkMessage(body, { chunkThreshold: 50, chunkSize: 100, charsPerToken: 1.0 });
  assert.equal(result.wasSharded, true);

  // We expect splits at or near "## Section" boundaries. Verify at least one
  // shard starts with "## Section".
  const startsWithHeading = result.shards.filter((s, i) => i > 0 && s.content.startsWith('## Section'));
  assert.ok(startsWithHeading.length >= 1, 'at least one mid-body shard should start at a heading');
});

test('chunker: handles long line without seams via hard split', () => {
  // One very long line with no whitespace at all
  const body = 'x'.repeat(500);
  const result = chunkMessage(body, TINY);
  assert.equal(result.wasSharded, true);
  // Byte-faithful even with hard splits
  assert.equal(result.shards.map((s) => s.content).join(''), body);
});

test('chunker: handles multi-byte UTF-8 (CJK) without corrupting characters', () => {
  // Some Japanese text + emoji
  const body = '日本語のテストです。' + '🌸'.repeat(50) + 'もう少しテキストを追加します。'.repeat(20);
  const result = chunkMessage(body, { chunkThreshold: 30, chunkSize: 25, charsPerToken: 1.0 });
  assert.equal(result.wasSharded, true);

  // Reassembly must be byte-faithful
  assert.equal(result.shards.map((s) => s.content).join(''), body);

  // Each shard's content should round-trip through UTF-8 cleanly
  for (const s of result.shards) {
    const bytes = Buffer.from(s.content, 'utf8');
    const decoded = bytes.toString('utf8');
    assert.equal(decoded, s.content, `shard ${s.index} did not round-trip through UTF-8`);
  }
});

test('chunker: sourceHash is stable across identical content in different runs', () => {
  const fragment = 'This is some content that should hash identically.';
  const r1 = chunkMessage(fragment + fragment + fragment + fragment + fragment, TINY);
  const r2 = chunkMessage(fragment + fragment + fragment + fragment + fragment, TINY);
  assert.equal(r1.shards[0].sourceHash, r2.shards[0].sourceHash);
});

test('chunker: bodyGroupId differs for different content', () => {
  const r1 = chunkMessage('a'.repeat(500), TINY);
  const r2 = chunkMessage('b'.repeat(500), TINY);
  assert.notEqual(r1.bodyGroupId, r2.bodyGroupId);
});

test('chunker: large doc (synthetic 500K-token-equivalent) produces sensible shard count', () => {
  // 500K tokens × 4 chars/token = 2M chars. Use a smaller synthetic stand-in to keep test fast.
  // 50K chars at default chunkSize 4096 tokens × 4 chars = 16K chars/shard → ~3-4 shards.
  // Use 200K chars to get ~12 shards.
  const para = 'Paragraph of content. '.repeat(20); // ~440 chars per "paragraph"
  const body = Array.from({ length: 500 }, () => para).join('\n\n'); // ~220K chars
  const result = chunkMessage(body); // default options
  assert.equal(result.wasSharded, true);
  // Each shard should be ≤ chunkSize tokens (with some slack for seam-finding)
  for (const s of result.shards) {
    assert.ok(
      s.approxTokens <= DEFAULT_CHUNKER_OPTIONS.chunkSize * 1.3,
      `shard ${s.index} has ${s.approxTokens} tokens, exceeds chunkSize`
    );
  }
  // Byte-faithful
  assert.equal(result.shards.map((s) => s.content).join(''), body);
});
