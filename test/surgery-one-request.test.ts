import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter, Membrane, NativeFormatter } from '@animalabs/membrane';
import { limitSurgeryTransport } from '../src/surgery/one-request-transport.js';

for (const status of [429, 500]) test(`surgery sends only one real SDK transport request on HTTP ${status}`, async () => {
  const adapter = new AnthropicAdapter({ apiKey: 'offline', cacheKeepalive: { enabled: false } });
  const seam = adapter as unknown as { client: { fetch: typeof fetch; maxRetries: number } };
  let sends = 0;
  seam.client.fetch = async () => {
    sends++;
    return new Response(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message: 'offline' } }), {
      status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1', 'x-should-retry': 'true' },
    });
  };
  limitSurgeryTransport(adapter);
  assert.equal(seam.client.maxRetries, 0);
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  await assert.rejects(membrane.complete({ messages: [{ participant: 'user', content: [{ type: 'text', text: 'offline' }] }], config: { model: 'claude-sonnet-4-5', maxTokens: 16 } }, { retry: false }));
  assert.equal(sends, 1);
  await assert.rejects(seam.client.fetch('https://never-sent.invalid'), /ONE_PROVIDER_REQUEST_CAP/);
  assert.equal(sends, 1);
});
test('an unknown SDK seam fails closed', () => {
  assert.throws(() => limitSurgeryTransport({}), /cannot enforce/);
});
