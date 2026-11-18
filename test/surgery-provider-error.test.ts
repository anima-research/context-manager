import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSurgeryProviderError } from '../src/surgery/provider-error.js';
test('sanitization retains the provider class and classification, never payload or original stack', () => {
  class ProviderError extends Error {}
  const original = Object.assign(new ProviderError('invalid_request thinking private source'), {
    type:'invalid_request', httpStatus:400, retryable:false, cause:new Error('private source'), payload:'private source',
  });
  const safe = sanitizeSurgeryProviderError(original);
  assert.ok(safe instanceof ProviderError);
  assert.equal(safe.type,'invalid_request');
  assert.equal(safe.httpStatus,400);
  assert.equal(safe.retryable,false);
  assert.match(safe.message,/thinking/);
  assert.ok(!JSON.stringify(safe).includes('private source'));
  assert.ok(!String(safe.stack).includes('private source'));
  assert.ok(!('payload' in safe));
  assert.equal(safe.cause,undefined);
  assert.match(original.message,/private source/, 'the provider exception is not mutated');
});
