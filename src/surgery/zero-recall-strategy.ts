import { AutobiographicalStrategy } from '../strategies/autobiographical.js';
import type { NormalizedRequest } from '@animalabs/membrane';
import { captureZeroRecallConstruction, transformConstructedZeroRecallCompression } from './zero-recall-compression.js';

/** Opt-in construction observer for the one-shot surgery, not a live strategy default.
 * Caller must run assertZeroRecallSourceSafe on stopped raw CM history first.
 * Recall removal authors the accepted request before dispatch and provenance hashing.
 */
export class ZeroRecallSurgeryStrategy extends AutobiographicalStrategy {
  protected override compressionOutcomeNamespace(): string | undefined { return 'zero-recall-surgery-v1'; }
  authoredRequest?: NormalizedRequest;
  transformation?: ReturnType<typeof transformConstructedZeroRecallCompression>;
  protected override authorL1CompressionRequest(request: NormalizedRequest, recallIds: readonly string[]): NormalizedRequest {
    this.observeL1CompressionRequest(request, recallIds);
    const transformed = transformConstructedZeroRecallCompression(request, this.opening(), this.construction!);
    const authored = { ...request, messages: transformed.messages };
    this.transformation = transformed;
    this.authoredRequest = structuredClone(authored);
    return authored;
  }
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
    // A carrier-only or empty answer can disappear on sanitization/retry,
    // leaving unrelated raw history immediately after its header. Require a
    // stable text payload in this opt-in operation rather than blessing it.
    if (this.summaries.some(s => recallIds.includes(s.id)
      && !this.summaryAnswerContent(s).some(b => b.type === 'text' && b.text.trim().length > 0))) {
      throw new Error('Unstable or empty recall answer; refusing zero-recall surgery');
    }
    const construction = captureZeroRecallConstruction(request, recallIds);
    // Stored answers with results are refused above. Any result that appears
    // only after splitting/collapse therefore belongs to raw source history.
    if (construction.expectedAnswers.some(({ answer }) => answer.content.some(b => b.type === 'tool_result'))) {
      throw new Error('Raw tool result collapsed into recall answer; refusing zero-recall surgery');
    }
    this.construction = construction;
  }
}
