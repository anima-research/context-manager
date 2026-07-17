import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { PrimarySummaryContract, PrimarySummaryIdentity, SummaryEntry } from '../src/types/index.js';

const BASE = './test-primary-summary-fallback';
let sequence = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${BASE}-${sequence++}`;
  paths.push(path);
  return path;
}

after(() => {
  for (const path of paths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }
}

function summary(id: string, sourceIds: string[], first: string, last: string, content = `authored ${id}`): SummaryEntry {
  return {
    id,
    level: 1,
    content,
    tokens: 20,
    sourceLevel: 0,
    sourceIds,
    sourceRange: { first, last },
    created: 1,
  };
}

async function createFixture(path = freshPath()) {
  const strategy = new ProbeStrategy({
    compressionModel: 'same-model',
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
  });
  const manager = await ContextManager.open({ path, strategy, membrane: {} as never });
  const ids: string[] = [];
  ids.push(manager.addMessage('User', [{ type: 'text', text: 'raw-0 substantive '.repeat(10) }]));
  ids.push(manager.addMessage('Claude', [
    { type: 'thinking', thinking: 'private reasoning', signature: 'sig-1' } as ContentBlock,
    { type: 'text', text: 'raw-1 substantive '.repeat(10) },
  ]));
  ids.push(manager.addMessage('Claude', [{
    type: 'tool_use',
    id: 'tool-1',
    name: 'echo',
    input: { message: 'hi' },
  } as ContentBlock]));
  ids.push(manager.addMessage('User', [{
    type: 'tool_result',
    toolUseId: 'tool-1',
    content: 'ok',
    isError: false,
  } as ContentBlock]));
  ids.push(manager.addMessage('User', [{ type: 'text', text: 'raw-4 substantive '.repeat(10) }]));

  const entry = summary('L1-1', [ids[0]!, ids[1]!, ids[2]!, ids[3]!], ids[0]!, ids[3]!);
  strategy.seed(entry);
  const compiled = await manager.compile({ maxTokens: 4000, reserveForResponse: 256 });
  return { manager, strategy, ids, entry, compiled };
}

function contract(tag: string): PrimarySummaryContract & { systemHash: string } {
  return {
    systemHash: `system-${tag}`,
    modelConfigHash: `model-${tag}`,
    toolContractHash: `tools-${tag}`,
  };
}

describe('primary summary fallback substrate', () => {
  it('fails closed when a selected summary identity cannot be constructed', async () => {
    const path = freshPath();
    const strategy = new ProbeStrategy({
      compressionModel: 'same-model',
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
    });
    const manager = await ContextManager.open({ path, strategy, membrane: {} as never });
    try {
      const ids: string[] = [];
      ids.push(manager.addMessage('User', [{ type: 'text', text: 'raw-0 substantive '.repeat(10) }]));
      ids.push(manager.addMessage('Claude', [{ type: 'text', text: 'raw-1 substantive '.repeat(10) }]));
      strategy.seed(summary('L1-bad', ['missing-1', 'missing-2'], ids[0]!, ids[1]!));
      await assert.rejects(
        manager.compile({ maxTokens: 4000, reserveForResponse: 256 }),
        /invalid leaf coverage|missing source message/,
      );
    } finally {
      await manager.close();
    }
  });

  it('raw expansion replaces only the selected summary pair and strips thinking blocks', async () => {
    const { manager, compiled, entry, ids } = await createFixture();
    try {
      compiled.messages[1]!.cacheBreakpoint = true;
      const expanded = manager.expandPrimarySummaryProjectionRaw(
        compiled,
        [compiled.primarySummaryProjection!.selectedSummaries[0]!.identity],
      );
      assert.equal(expanded.messages[0]!.participant, 'User');
      assert.equal(expanded.messages[1]!.participant, 'Claude');
      assert.deepEqual(
        expanded.messages[1]!.content.map((block) => block.type),
        ['text'],
        'thinking must be stripped during raw expansion',
      );
      assert.equal((expanded.messages[1]!.content[0] as { text: string }).text.includes('raw-1 substantive'), true);
      assert.equal(expanded.messages[2]!.content[0]!.type, 'tool_use');
      assert.equal(expanded.messages[3]!.content[0]!.type, 'tool_result');
      assert.equal(
        expanded.primarySummaryProjection!.selectedSummaries[0]!.renderedAs,
        'raw_expansion',
      );
      assert.equal(
        expanded.messages.some((message) =>
          message.participant === 'Context Manager' &&
          message.content[0]?.type === 'text' &&
          (message.content[0] as { text: string }).text === '[Recall L1-1]'),
        false,
      );
      assert.deepEqual(
        expanded.primarySummaryProjection!.selectedSummaries[0]!.orderedSourceIds,
        [ids[0]!, ids[1]!, ids[2]!, ids[3]!],
      );
      assert.equal(expanded.messages.some((message) => message.cacheBreakpoint === true), true);
      assert.equal(entry.id, 'L1-1');
    } finally {
      await manager.close();
    }
  });

  it('quarantine matching includes the system hash and survives restart', async () => {
    const path = freshPath();
    const first = await createFixture(path);
    try {
      await first.manager.quarantinePrimarySummaryForPrimaryLane(
        contract('a'),
        [first.compiled.primarySummaryProjection!.selectedSummaries[0]!.identity],
      );
      assert.deepEqual(
        first.manager.matchingPrimarySummaryQuarantine(
          first.compiled.primarySummaryProjection!,
          contract('a'),
        ).map((item: PrimarySummaryIdentity) => item.id),
        ['L1-1'],
      );
      assert.deepEqual(
        first.manager.matchingPrimarySummaryQuarantine(
          first.compiled.primarySummaryProjection!,
          contract('b'),
        ),
        [],
      );
    } finally {
      await first.manager.close();
    }

    const second = await createFixture(path);
    try {
      assert.deepEqual(
        second.manager.matchingPrimarySummaryQuarantine(
          second.compiled.primarySummaryProjection!,
          contract('a'),
        ).map((item: PrimarySummaryIdentity) => item.id),
        ['L1-1'],
      );
      assert.deepEqual(
        second.manager.matchingPrimarySummaryQuarantine(
          second.compiled.primarySummaryProjection!,
          contract('b'),
        ),
        [],
      );
    } finally {
      await second.manager.close();
    }
  });

  it('branch-local quarantine does not leak across a branch switch and back', async () => {
    const { manager, compiled } = await createFixture();
    try {
      await manager.quarantinePrimarySummaryForPrimaryLane(
        contract('branch'),
        [compiled.primarySummaryProjection!.selectedSummaries[0]!.identity],
      );
      const main = manager.currentBranch().name;
      const fork = manager.branchAt(compiled.primarySummaryProjection!.selectedSummaries[0]!.orderedSourceIds[0]!, 'fallback-fork');
      await manager.switchBranch(fork);
      const forkCompiled = await manager.compile({ maxTokens: 4000, reserveForResponse: 256 });
      assert.deepEqual(
        manager.matchingPrimarySummaryQuarantine(
          forkCompiled.primarySummaryProjection!,
          contract('branch'),
        ),
        [],
      );
      await manager.switchBranch(main);
      const again = await manager.compile({ maxTokens: 4000, reserveForResponse: 256 });
      assert.deepEqual(
        manager.matchingPrimarySummaryQuarantine(
          again.primarySummaryProjection!,
          contract('branch'),
        ),
        [],
      );
    } finally {
      await manager.close();
    }
  });
});
