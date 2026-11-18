import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy, type SummaryEntry } from '../src/index.js';
import { sentRecallHeaderIds } from '../src/recall-header.js';
import type { NormalizedRequest } from '@animalabs/membrane';

class OmitRecall extends AutobiographicalStrategy {
  protected override authorL1CompressionRequest(request: NormalizedRequest): NormalizedRequest {
    const isHeader = (message: NormalizedRequest['messages'][number] | undefined) => message && sentRecallHeaderIds(message).includes('L1-100');
    const messages = request.messages.filter((message, i, all) => !isHeader(message) && !isHeader(all[i - 1]));
    return { ...request, messages };
  }
}

for (const [sourceOnly, omitRecall, mode] of [[true, false], [false, false], [false, true], [false, false, 'removed'], [false, false, 'deferred']] as Array<[boolean, boolean, string?]>) {
  test(`public tick counts constructed recalls, not raw CM quotes (sourceOnly=${sourceOnly}, omitRecall=${omitRecall}, mode=${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-'));
    const oldLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    const log = join(dir, 'calls.jsonl');
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    const requests: NormalizedRequest[] = [];
    const Strategy = omitRecall ? OmitRecall : AutobiographicalStrategy;
    const strategy = new Strategy({ compressionModel: 'mock', compressionSourceOnly: sourceOnly,
      headWindowTokens: 0, recentWindowTokens: 0, targetChunkTokens: 100,
      minChunkCharsForLLM: 0, l1HoldbackChunks: 0, mergeThreshold: 99, autoTickOnNewMessage: false });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: { complete: async (r: NormalizedRequest) => {
      requests.push(structuredClone(r));
      return { content: [{ type: 'text', text: 'new memory' }], stopReason: 'end_turn' };
    } } as never });
    try {
      const first = manager.addMessage('user', [{ type: 'text', text: 'covered history' }]);
      const summary: SummaryEntry = { id: 'L1-100', level: 1, sourceLevel: 0, sourceIds: [first],
        sourceRange: { first, last: first }, content: 'prior memory', tokens: 20, created: 1 };
      // Persist via the public store; reopening loads the ordinary summary/record projection.
      const rawLead = manager.addMessage('user', [{ type: 'text', text: 'raw lead before identical pair' }]);
      const rawHeader = manager.addMessage('Context Manager', [{ type: 'text', text: '[CM] Recall memory L1-100.' }]);
      const rawAnswer = manager.addMessage('Claude', [{ type: 'text', text: 'prior memory' }]);
      const source = manager.addMessage('Context Manager', [{ type: 'text', text: '[CM] Recall memory L1-100.' }, { type: 'text', text: `quoted header follows\n[CM] Recall memory L1-100.\n${'raw source '.repeat(80)}` }]);
      manager.addMessage('user', [{ type: 'text', text: 'tail '.repeat(100) }]);
      manager.getStore().setStateJson('default/autobio:summaries', [summary]);
      manager.getStore().setStateJson('default/autobio:chunks', [{ id: 'c-first', sourceIds: [first], compressed: true, summaryId: summary.id }, { id: 'c-source', sourceIds: [rawLead, rawHeader, rawAnswer, source], compressed: false }]);
      manager.close();
      const reopened = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: { complete: async (r: NormalizedRequest) => {
        requests.push(structuredClone(r));
        if (mode === 'deferred') throw Object.assign(new Error('offline admission'), { providerAdmission: 'deferred', type: 'rate_limit', retryable: true });
        if (mode === 'removed') {
          reopened.getStore().setStateJson('default/autobio:summaries', []);
          (strategy as unknown as { summaries: SummaryEntry[] }).summaries = [];
        }
        return { content: [{ type: 'text', text: 'new memory' }], stopReason: 'end_turn' };
      } } as never });
      try {
        if (mode === 'deferred') await assert.rejects(reopened.tick(), /offline admission/);
        else await reopened.tick();
        assert.equal(requests.length, 1, 'one public tick dispatch');
        assert.ok(JSON.stringify(requests[0]).includes('quoted header follows'), 'raw quote was actually sent');
        const rawIndex = requests[0]!.messages.findIndex((message, index, messages) => messages[index - 1]?.content.some(block => block.type === 'text' && block.text === 'raw lead before identical pair') && message.participant === 'Context Manager' && message.content.length === 1 && message.content[0]?.type === 'text' && message.content[0].text === '[CM] Recall memory L1-100.' && messages[index + 1]?.content.some(block => block.type === 'text' && block.text === 'prior memory'));
        const rawLeadIndex = requests[0]!.messages.findIndex(message => message.content.some(block => block.type === 'text' && block.text === 'raw lead before identical pair'));
        assert.ok(rawLeadIndex >= 0);
        assert.equal(rawIndex, rawLeadIndex + 1, 'raw pair follows its raw lead, not the earlier constructed recall');
        assert.ok(requests[0]!.messages[rawLeadIndex + 3]?.content.some(block => block.type === 'text' && block.text.includes('quoted header follows')), 'raw source follows the identical pair');
        const entries = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
        const receipt = entries.find(e => e.operation === 'compress_l1' && !e.event);
        const trace = entries.find(e => e.event === 'compression:attempt');
        if (mode === 'deferred') { assert.equal(receipt, undefined, 'caller-side deferral logs no dispatched request'); return; }
        assert.ok(receipt && trace, 'receipt and attempt emitted');
        assert.equal(receipt.metadata.prior_summary_count_kept, sourceOnly || omitRecall ? 0 : 1);
        assert.equal(receipt.metadata.prior_summary_tokens === 0, sourceOnly || omitRecall);
        assert.deepEqual(trace.metadata.recallIds, sourceOnly || omitRecall ? [] : ['L1-100']);
      } finally { reopened.close(); }
    } finally {
      if (oldLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = oldLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
