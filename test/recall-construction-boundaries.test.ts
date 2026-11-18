import test from 'node:test';
import assert from 'node:assert/strict';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import { constructedRecallHeader } from '../src/recall-header.js';
import type { NormalizedRequest } from '@animalabs/membrane';

class Probe extends AutobiographicalStrategy {
  separate(messages: NormalizedRequest['messages']) { return this.separateRecallAnswers(messages); }
  seams(messages: NormalizedRequest['messages']) {
    return this.applyMintCacheSeams(messages, [{ id: 'L1-0', level: 1 } as never], false);
  }
}
const text = (participant: string, value: string) => ({ participant, content: [{ type: 'text' as const, text: value }] });
test('only constructed recalls separate answers and anchor cache seams despite identical raw headers', () => {
  const strategy = new Probe();
  const raw = [text('Context Manager', '[CM] Recall memory L1-0.'), text('Claude', 'raw first'), text('Claude', 'raw second')];
  assert.deepEqual(strategy.separate(raw), raw, 'raw L1 prefix and L2 sources get no synthetic turn');
  const messages = [{ participant: 'Context Manager', content: [constructedRecallHeader('L1-0')] }, text('Claude', 'memory'), ...raw];
  assert.equal(strategy.seams(messages), true);
  assert.equal((messages[1] as { cacheBreakpoint?: boolean }).cacheBreakpoint, true);
  assert.equal((messages[3] as { cacheBreakpoint?: boolean }).cacheBreakpoint, undefined);
  const pair = [messages[0]!, messages[1]!, text('Claude', 'raw')];
  assert.equal(strategy.separate(pair).length, 4, 'real recall answers still get a resume turn');
});
