import { SurgeryTransportCapError } from '../src/surgery/one-request-transport.js';
import test from 'node:test';
import { CompressionWithdrawn, isCompressionWithdrawn } from '../src/compression-withdrawn.js';
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

test('sanitization preserves own withdrawal and admission classification', () => {
  const error = Object.assign(new CompressionWithdrawn('private source'), {
    providerAdmission: 'deferred', retryAfterMs: 1234, providerErrorCode: 'offline_code',
  });
  const safe = sanitizeSurgeryProviderError(error);
  assert.equal(isCompressionWithdrawn(safe), true);
  assert.equal(safe.providerAdmission, 'deferred');
  assert.equal(safe.retryAfterMs, 1234);
  assert.equal(safe.providerErrorCode, 'offline_code');
  assert.ok(!JSON.stringify(safe).includes('private source'));
});

test('non-string provider messages cannot break sanitization', () => {
  const safe = sanitizeSurgeryProviderError({type:'context_length', message:400});
  assert.equal(safe.type, 'context_length');
});

test('local transport cap keeps its trusted diagnostic', () => {
  assert.match(sanitizeSurgeryProviderError(new SurgeryTransportCapError()).message, /ONE_PROVIDER_REQUEST_CAP/);
  assert.doesNotMatch(sanitizeSurgeryProviderError(new Error('ONE_PROVIDER_REQUEST_CAP private')).message, /ONE_PROVIDER_REQUEST_CAP/);
});


test('DOMException cancellation survives getter-only prototype fields', () => {
  const original = new DOMException('private source', 'AbortError');
  const safe = sanitizeSurgeryProviderError(original);
  assert.ok(safe instanceof DOMException);
  assert.ok(safe instanceof Error);
  assert.equal(safe.name, 'AbortError');
  assert.match(safe.message, /message omitted/);
  assert.ok(!String(safe.stack).includes('private source'));
});

test('read-only inherited classification fields do not prevent a safe projection', () => {
  class ProviderError extends Error {
    get type() { return 'rate_limit'; }
    get httpStatus() { return 429; }
    get retryable() { return true; }
  }
  const safe = sanitizeSurgeryProviderError(new ProviderError('private source'));
  assert.ok(safe instanceof ProviderError);
  assert.equal(safe.type, 'rate_limit');
  assert.equal(safe.httpStatus, 429);
  assert.equal(safe.retryable, true);
});
