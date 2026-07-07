/**
 * Bug 6.7: context-manager had no full post-selection tool-pair validation —
 * only trailing (`trimOrphanedToolUse`) and leading orphan trims. Mid-list
 * orphans (a budget break cutting a raw pin pair; the uncompressed-chunk
 * fallback emitting a raw tool_result whose tool_use chunk already
 * compressed) sailed through to the wire layer.
 *
 * `enforceToolPairing` is the final structural pass in selectHierarchical:
 * every tool_use must be answered by a matching tool_result in the
 * immediately-following entry, and every tool_result must answer a tool_use
 * in the immediately-preceding entry. Repair prefers preserving pairs
 * (stub tool_result) over dropping content.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { ContextEntry } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Invariant checker (mirrors the Anthropic API's structural rules)
// ---------------------------------------------------------------------------

function assertPaired(entries: ContextEntry[]): void {
  for (let i = 0; i < entries.length; i++) {
    for (const block of entries[i].content) {
      if (block.type === 'tool_use') {
        const id = (block as { id: string }).id;
        const next = entries[i + 1];
        assert.ok(
          next?.content.some(
            (b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === id,
          ),
          `entries[${i}]: tool_use ${id} not answered in entries[${i + 1}]`,
        );
      }
      if (block.type === 'tool_result') {
        const tid = (block as { toolUseId: string }).toolUseId;
        const prev = entries[i - 1];
        assert.ok(
          prev?.content.some(
            (b) => b.type === 'tool_use' && (b as { id: string }).id === tid,
          ),
          `entries[${i}]: tool_result ${tid} has no tool_use in entries[${i - 1}]`,
        );
      }
    }
  }
}

function entry(participant: string, content: ContentBlock[]): ContextEntry {
  return { index: 0, participant, content };
}

function text(t: string): ContentBlock {
  return { type: 'text', text: t };
}
function use(id: string): ContentBlock {
  return { type: 'tool_use', id, name: 'fn', input: {} };
}
function result(id: string, body = 'ok'): ContentBlock {
  return { type: 'tool_result', toolUseId: id, content: body };
}

function runEnforce(entries: ContextEntry[]): ContextEntry[] {
  const strategy = new AutobiographicalStrategy({});
  (strategy as unknown as { enforceToolPairing: (e: ContextEntry[]) => void })
    .enforceToolPairing(entries);
  return entries;
}

describe('enforceToolPairing — post-selection pairing validator', () => {
  it('leaves already-valid output untouched', () => {
    const entries = [
      entry('User', [text('hello')]),
      entry('Claude', [text('working'), use('A')]),
      entry('User', [result('A')]),
      entry('Claude', [text('done')]),
    ];
    entries.forEach((e, i) => { e.index = i; });
    const snapshot = JSON.stringify(entries);
    runEnforce(entries);
    assert.strictEqual(JSON.stringify(entries), snapshot, 'valid input must pass through unchanged');
    assertPaired(entries);
  });

  it('drops a mid-list orphan tool_result (its tool_use was compressed away)', () => {
    const entries = [
      entry('Claude', [text('summary of earlier work')]),
      // Raw tool_result whose tool_use chunk already compressed — the
      // uncompressed-chunk fallback shape.
      entry('User', [result('GONE', 'orphaned payload')]),
      entry('Claude', [text('later message')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
    // Entry preserved as a placeholder, not silently deleted.
    assert.strictEqual(entries.length, 3);
    assert.ok(
      entries[1].content.every((b) => b.type !== 'tool_result'),
      'orphan tool_result block must be removed',
    );
  });

  it('stubs a mid-list tool_use whose result entry was dropped by a budget break', () => {
    const entries = [
      entry('Claude', [text('let me check'), use('A')]),
      // The tool_result entry got cut by a budget break; next entry is
      // ordinary conversation.
      entry('User', [text('unrelated next message')]),
      entry('Claude', [text('reply')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
    // The tool_use is preserved (not dropped) and answered by a stub.
    assert.ok(
      entries[0].content.some((b) => b.type === 'tool_use'),
      'tool_use must be preserved',
    );
    const stub = entries[1];
    assert.ok(
      stub.content.some(
        (b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'A',
      ),
      'a stub tool_result entry must be inserted immediately after the tool_use',
    );
  });

  it('adds stubs for partially-answered parallel tool_use blocks', () => {
    const entries = [
      entry('Claude', [use('A'), use('B'), use('C')]),
      entry('User', [result('B')]),
      entry('Claude', [text('continues')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
    const ids = entries[1].content
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { toolUseId: string }).toolUseId)
      .sort();
    assert.deepStrictEqual(ids, ['A', 'B', 'C'], 'missing results must be stubbed alongside the real one');
  });

  it('repairs a recall pair interleaved between a tool_use and its (now non-adjacent) result', () => {
    const entries = [
      entry('Claude', [use('A')]),
      // A recall pair landed between the pair members.
      entry('Context Manager', [text('[CM] Recall memory L1-3.')]),
      entry('Claude', [text('I remember researching X.')]),
      entry('User', [result('A', 'the real result, now orphaned')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
  });

  it('handles consecutive tool_use entries (double budget cut)', () => {
    const entries = [
      entry('Claude', [use('A')]),
      entry('Claude', [use('B')]),
      entry('User', [result('B')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
  });

  it('appends a stub entry for a trailing unanswered tool_use', () => {
    const entries = [
      entry('User', [text('hi')]),
      entry('Claude', [text('checking'), use('C')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
    assert.strictEqual(entries.length, 3, 'a stub results entry must be appended');
    assert.ok(
      entries[2].content.some(
        (b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'C',
      ),
    );
  });

  it('dedupes duplicate tool_results for the same id', () => {
    const entries = [
      entry('Claude', [use('A')]),
      entry('User', [result('A', 'first'), result('A', 'second')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
    const count = entries[1].content.filter((b) => b.type === 'tool_result').length;
    assert.strictEqual(count, 1, 'duplicate tool_result for the same id must be dropped');
  });

  it('reindexes entries after inserting stub entries', () => {
    const entries = [
      entry('Claude', [use('A')]),
      entry('User', [text('not a result')]),
    ];
    runEnforce(entries);
    assertPaired(entries);
    for (let i = 0; i < entries.length; i++) {
      assert.strictEqual(entries[i].index, i, `entry ${i} has stale index ${entries[i].index}`);
    }
  });
});
