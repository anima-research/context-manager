import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NormalizedMessage } from '@animalabs/membrane';
import { transformZeroRecallCompression } from '../src/surgery/zero-recall-compression.js';

const text = (participant: string, value: string): NormalizedMessage => ({ participant, content: [{ type: 'text', text: value }] });

test('zero-recall surgery removes whole pairs and preserves all other messages', () => {
  const signedAnswer: NormalizedMessage = {
    participant: 'mythos',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'summary' }],
  };
  const source = text('user', 'source');
  const instruction = text('Context Manager', 'Compress now.');
  const input = [
    text('user', 'head'),
    text('Context Manager', '[CM] Recall memory L1-1.'),
    signedAnswer,
    text('Context Manager', '[CM] Recall memory L2-2.'),
    text('mythos', 'another summary'),
    source,
    instruction,
  ];
  const result = transformZeroRecallCompression(input);
  assert.deepEqual(result.removedRecallIds, ['L1-1', 'L2-2']);
  assert.equal(result.originalMessageCount, 7);
  assert.equal(result.sentMessageCount, 3);
  assert.deepEqual(result.messages[0], input[0]);
  assert.deepEqual(result.messages[1], source);
  assert.deepEqual(result.messages[2], instruction);
  assert.notEqual(result.originalSha256, result.transformedSha256);
});

test('zero-recall surgery refuses malformed or absent recall geometry', () => {
  assert.throws(() => transformZeroRecallCompression([text('user', 'source'), text('Context Manager', 'Compress now.')]), /No recall pairs/);
  assert.throws(() => transformZeroRecallCompression([text('Context Manager', '[CM] Recall memory L1-1.')]), /missing assistant answer/);
});

test('zero-recall surgery CLI refuses a custom opening before reading the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-recall-cli-'));
  try {
    const config = {
      storePath: join(dir, 'absent-store'), namespace: 'agents/resident', branchName: 'surgery/resident/test',
      expectedParentBranch: 'main', expectedRecordsSha256: 'sha256', toolsPath: join(dir, 'tools.json'),
      expectedToolsSha256: 'sha256', targetChunkIndex: 0, expectedSourceRange: ['a', 'b'],
      expectedQuarantineKey: 'key', summaryParticipant: 'resident', strategyConfig: {},
      receiptPath: join(dir, 'receipt.json'), acknowledgeStoppedCopiedOrBackedUpStore: true,
    };
    const runCli = (strategyConfig: Record<string, unknown>) => {
      const path = join(dir, 'op.json');
      writeFileSync(path, JSON.stringify({ ...config, strategyConfig }));
      return spawnSync(process.execPath, [resolve('dist/scripts/one-shot-zero-recall-surgery.js'), '--config', path],
        { encoding: 'utf8', timeout: 30_000 });
    };
    const refused = runCli({ compressionInstructions: { templates: { opening: '[CM] Recall memory x.' } } });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not supported with a custom compressionInstructions\.templates\.opening/);
    // Other templates pass this check and stop at the absent store instead.
    const other = runCli({ compressionInstructions: { templates: { chunk: 'Remember {targetTokens}.' } } });
    assert.notEqual(other.status, 0);
    assert.doesNotMatch(other.stderr, /custom compressionInstructions/);
    assert.match(other.stderr, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
