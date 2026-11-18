export class SurgeryTransportCapError extends Error {
  constructor() { super('ONE_PROVIDER_REQUEST_CAP'); }
}

/** The adapter has no public SDK-options seam in supported Membrane releases.
 * Fail closed if that seam changes, rather than silently restoring paid retries.
 * This is confined to the disposable one-shot CLI, never normal host traffic.
 */
export function limitSurgeryTransport(adapter: object): void {
  type Client = { fetch: typeof fetch; maxRetries: number; withOptions(options: { maxRetries: number; fetch: typeof fetch }): Client };
  const owner = adapter as { client?: Client };
  const client = owner.client;
  if (!client || typeof client.withOptions !== 'function' || typeof client.fetch !== 'function') {
    throw new Error('Unsupported Anthropic SDK transport; cannot enforce one provider request');
  }
  const transport = client.fetch.bind(client);
  let attempted = false;
  const guarded: typeof fetch = async (input, init) => {
    if (attempted) throw new SurgeryTransportCapError();
    attempted = true; // A failed/ambiguous send also consumes the only slot.
    return transport(input, { ...init, redirect: 'error' });
  };
  owner.client = client.withOptions({ maxRetries: 0, fetch: guarded });
  if (owner.client.maxRetries !== 0 || owner.client.fetch !== guarded) {
    throw new Error('Anthropic SDK did not retain the one-request transport');
  }
}
