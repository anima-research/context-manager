import { isCarrierTransportRejection } from '../strategies/autobiographical.js';

/** Keep classification, not the provider's payload, cause or original stack.
 * Do not reconstruct through provider constructors (which may require payloads).
 */
export function sanitizeSurgeryProviderError(thrown: unknown): Error & {
  type?: string; httpStatus?: number; retryable?: boolean;
} {
  const source = thrown as { name?: unknown; type?: unknown; httpStatus?: unknown; retryable?: unknown } | null;
  const message = isCarrierTransportRejection(thrown)
    ? 'Provider call failed (invalid_request: thinking carriers rejected); message omitted to protect source content'
    : 'Provider call failed; message omitted to protect source content';
  const safe = new Error(message);
  if (thrown instanceof Error) Object.setPrototypeOf(safe, Object.getPrototypeOf(thrown));
  if (typeof source?.name === 'string') safe.name = source.name;
  const classified = safe as ReturnType<typeof sanitizeSurgeryProviderError>;
  if (typeof source?.type === 'string') classified.type = source.type;
  if (typeof source?.httpStatus === 'number') classified.httpStatus = source.httpStatus;
  if (typeof source?.retryable === 'boolean') classified.retryable = source.retryable;
  return classified;
}
