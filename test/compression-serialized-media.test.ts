import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy } from '../src/index.js';

class ExposedAutobiographicalStrategy extends AutobiographicalStrategy {
  stripSerializedMedia(messages: Array<{ content: ContentBlock[] }>): number {
    return this.stripSerializedCompressionMedia(messages);
  }
}

describe('compression prompt serialized-media projection', () => {
  it('omits a large data URL from text without mutating the original block', () => {
    const strategy = new ExposedAutobiographicalStrategy();
    const payload = 'A'.repeat(5000);
    const original: ContentBlock = {
      type: 'text',
      text: `before data:image/png;base64,${payload} after`,
    };
    const messages = [{ content: [original] }];

    assert.equal(strategy.stripSerializedMedia(messages), 1);
    assert.match(
      (messages[0].content[0] as { type: 'text'; text: string }).text,
      /before \[embedded image\/png data URL omitted from compression prompt: 5000 base64 characters; original preserved in Chronicle\] after/,
    );
    assert.equal((original as { type: 'text'; text: string }).text.includes(payload), true);
  });

  it('also finds serialized media nested in tool results', () => {
    const strategy = new ExposedAutobiographicalStrategy();
    const payload = 'B'.repeat(6000);
    const messages = [{
      content: [{
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: [{ type: 'text', text: `data:application/pdf;base64,${payload}` }],
      } as ContentBlock],
    }];

    assert.equal(strategy.stripSerializedMedia(messages), 1);
    const nested = (messages[0].content[0] as unknown as { content: ContentBlock[] }).content[0];
    assert.match(
      (nested as { type: 'text'; text: string }).text,
      /embedded application\/pdf data URL omitted/,
    );
  });

  it('leaves short data-URL examples intact', () => {
    const strategy = new ExposedAutobiographicalStrategy();
    const text = 'example data:image/png;base64,aGVsbG8=';
    const messages = [{ content: [{ type: 'text', text } as ContentBlock] }];

    assert.equal(strategy.stripSerializedMedia(messages), 0);
    assert.equal((messages[0].content[0] as { type: 'text'; text: string }).text, text);
  });
});
