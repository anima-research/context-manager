import { AutobiographicalStrategy } from '../strategies/autobiographical.js';
import type { NormalizedRequest } from '@animalabs/membrane';
import { captureZeroRecallConstruction } from './zero-recall-compression.js';

/** Opt-in construction observer for the one-shot surgery, not a live strategy default.
 * Caller must run assertZeroRecallSourceSafe on stopped raw CM history first.
 * Snapshots are ephemeral and must be matched before editing the intercepted request.
 */
export class ZeroRecallSurgeryStrategy extends AutobiographicalStrategy {
  construction?: ReturnType<typeof captureZeroRecallConstruction>;
  opening() {
    // Use production preparation for custom openings containing serialized media.
    return this.prepareCompressionRequest({ messages: [{ participant: 'Context Manager',
      content: [{ type: 'text', text: this.getCompressionOpening() }] }], config: {} } as NormalizedRequest)
      .request.messages[0]!.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  protected override observeL1CompressionRequest(request: NormalizedRequest, recallIds: readonly string[]) {
    // A tool_result can split one stored answer into several turns. Surgery
    // intentionally only removes isolated, single-turn answers; never bless a
    // fragment as the complete memory after tool normalization.
    if (this.summaries.some(s => recallIds.includes(s.id)
      && this.summaryAnswerContent(s).some(b => b.type === 'tool_result'))) {
      throw new Error('Split recall answer; refusing zero-recall surgery');
    }
    this.construction = captureZeroRecallConstruction(request, recallIds);
  }
}
