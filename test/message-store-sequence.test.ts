/**
 * Regression test for the message-store sequence-vs-index bug.
 *
 * Before this fix, `MessageStore.get(id).sequence` returned the message's
 * SLOT INDEX (its position in the message-store append-log) rather than the
 * CHRONICLE RECORD SEQUENCE at which it was appended. Those two numbers
 * diverge whenever any non-message record is appended between messages —
 * which the autobio strategy does heavily, with `state_update` records for
 * summary appends, mergeQueue snapshots, counter increments, etc. The
 * typical ratio is ~1:2 (slot index : chronicle seq).
 *
 * `ContextManager.branchAt(messageId)` then passed `message.sequence` to
 * `chronicle.createBranchAt(name, from, atSequence)`, which expects the
 * chronicle sequence. Result: forks landed at chronicle sequence equal to
 * the slot index — silently dropping every chronicle record between the
 * intended fork point and the actual one. For an 800-message conversation
 * this could fork ~400 messages back instead of one turn back.
 *
 * The fix returns `internal.sequence` (which is correctly populated from
 * `record.sequence` at append time). These tests pin the contract so a
 * future refactor can't reintroduce the "use index as sequence for now"
 * shortcut.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-message-store-sequence';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

describe('MessageStore — sequence semantics', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('returned sequence equals the chronicle record sequence (not the slot index)', async () => {
    // Use the autobiographical strategy so its background state appends
    // (counter, summaries, etc.) interleave with message appends — that's
    // what makes slot-index and chronicle-sequence diverge.
    const strategy = new AutobiographicalStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = manager.addMessage('user', textBlock(`m${i}`));
      ids.push(id);
    }

    // Walk the store: each successive message must have a STRICTLY GREATER
    // chronicle sequence than the previous, AND the sequence must not equal
    // the slot index (which is what the old code returned). The "not equal"
    // half is the actual regression assertion.
    const { messages } = manager.queryMessages({});
    assert.equal(messages.length, 5);

    let prevSeq = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      assert.ok(
        typeof m.sequence === 'number' && Number.isFinite(m.sequence),
        `message[${i}].sequence must be a finite number`,
      );
      assert.ok(
        m.sequence > prevSeq,
        `message[${i}].sequence (${m.sequence}) must be > previous (${prevSeq})`,
      );
      assert.notEqual(
        m.sequence,
        i,
        `message[${i}].sequence (${m.sequence}) must not equal its slot index (${i}) — ` +
          'that was the bug. Chronicle sequences are dense across all record types, not just messages.',
      );
      prevSeq = m.sequence;
    }

    // Belt-and-suspenders: also confirm get() agrees with query()'s view.
    const last = manager.getMessage(ids[ids.length - 1]);
    assert.ok(last, 'get(lastId) must return the message');
    assert.equal(
      last!.sequence,
      messages[messages.length - 1].sequence,
      'get() and query() must report the same sequence for the same message',
    );

    manager.close();
  });

  it('branchAt forks at the chronicle sequence — branch sees N messages, not slot-index-many', async () => {
    // The end-to-end shape of the original bug. If sequence-vs-index is
    // wrong, branchAt(messages[N-1].id) creates a fork at chronicle seq
    // == (N-1), which lands far earlier than intended and the new branch
    // sees only ~half the messages.
    const strategy = new AutobiographicalStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = manager.addMessage('user', textBlock(`m${i}`));
      ids.push(id);
    }

    // Fork at the 5th message (index 4). The new branch must see exactly
    // the first 5 messages — anything fewer means the fork landed at
    // a too-early chronicle sequence (the bug).
    const newBranch = manager.branchAt(ids[4]);
    await manager.switchBranch(newBranch);

    const { messages: onBranch } = manager.queryMessages({});
    assert.equal(
      onBranch.length,
      5,
      `forked branch must see exactly 5 messages, got ${onBranch.length}. ` +
        'A smaller count means branchAt forked at the slot index instead of the chronicle sequence.',
    );
    // Verify the contents AND that fork-point message has full id/sequence
    // (not undefined). Pre-fix #2, the fork-point message was visible only
    // in its pre-patch form on the new branch — id and sequence undefined —
    // because MessageStore.add() does append-then-editStateItem, and
    // forking at the original append's sequence captured the pre-patch
    // state. Fix #2 stores the EDIT's sequence as the canonical
    // commit-sequence, so a fork at messageId.sequence now lands at the
    // edit record and the patched payload is inherited intact.
    for (let i = 0; i < 5; i++) {
      const text = onBranch[i]?.content?.[0];
      assert.ok(
        text && text.type === 'text' && text.text === `m${i}`,
        `forked branch message[${i}] should be "m${i}", got ${JSON.stringify(text)}`,
      );
      assert.ok(
        onBranch[i].id !== undefined && onBranch[i].id !== null,
        `forked branch message[${i}].id must be defined (was the chained-branching bug), got ${onBranch[i].id}`,
      );
      assert.ok(
        typeof onBranch[i].sequence === 'number' && Number.isFinite(onBranch[i].sequence),
        `forked branch message[${i}].sequence must be a finite number, got ${onBranch[i].sequence}`,
      );
    }
    // The most specific check: the fork-point message on the new branch
    // must equal the fork-point message on main (same id).
    assert.equal(
      onBranch[onBranch.length - 1].id,
      ids[4],
      'fork-point message on the new branch must have the same id as on main',
    );

    manager.close();
  });

  it('chained branching at the fork-point message preserves full message state', async () => {
    // The bonus chained-branching bug: pre-fix, the FORK-POINT message
    // on a new branch had id and sequence = undefined, because the
    // append-then-patch dance left its patched payload at a chronicle
    // sequence one PAST the fork-point. Anyone trying to branchAt the
    // fork-point message on a forked branch would hit
    // `idToIndex.get(undefined)` returning nothing → "Message not found".
    // This test catches that by chaining two forks where the second
    // forks AT the prior fork's fork-point message.
    const strategy = new AutobiographicalStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = manager.addMessage('user', textBlock(`m${i}`));
      ids.push(id);
    }

    // Fork 1: at message index 4 (sees first 5 messages)
    const fork1 = manager.branchAt(ids[4], 'chained-fork-1');
    await manager.switchBranch(fork1);
    const { messages: onFork1 } = manager.queryMessages({});
    assert.equal(onFork1.length, 5);

    // The fork-point message on fork1 must have full id/sequence — that's
    // the precondition for branchAt to work from it.
    const forkPointMsg = onFork1[onFork1.length - 1];
    assert.ok(
      forkPointMsg.id !== undefined && forkPointMsg.id !== null,
      'fork-point message on a forked branch must have a defined id (was the chained-branching bug)',
    );
    assert.ok(
      typeof forkPointMsg.sequence === 'number' && Number.isFinite(forkPointMsg.sequence),
      'fork-point message on a forked branch must have a finite sequence',
    );

    // Fork 2: from fork1, AT the fork-point message of fork1.
    // Pre-fix this throws "Message not found: undefined" because
    // forkPointMsg.id is undefined on fork1.
    const fork2 = manager.branchAt(forkPointMsg.id, 'chained-fork-2');
    await manager.switchBranch(fork2);
    const { messages: onFork2 } = manager.queryMessages({});
    assert.equal(
      onFork2.length,
      5,
      'fork2 forked at fork1.fork-point should see the same 5 messages as fork1',
    );

    manager.close();
  });
});
