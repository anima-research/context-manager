import { SurgeryTransportCapError } from './one-request-transport.js';
import { isCompressionWithdrawn } from '../compression-withdrawn.js';
import { isCarrierTransportRejection } from '../strategies/autobiographical.js';

/** Keep classification, not the provider's payload, cause or original stack.
 * Do not reconstruct through provider constructors (which may require payloads).
 */
export function sanitizeSurgeryProviderError(thrown: unknown): Error & {
  type?: string; httpStatus?: number; retryable?: boolean;
  providerAdmission?: 'deferred'; retryAfterMs?: number; providerErrorCode?: string;
} {
  const source = thrown as { name?: unknown; type?: unknown; httpStatus?: unknown; retryable?: unknown; providerAdmission?: unknown; retryAfterMs?: unknown; providerErrorCode?: unknown } | null;
  const message = thrown instanceof SurgeryTransportCapError ? 'ONE_PROVIDER_REQUEST_CAP: local transport guard prevented another send' : isCarrierTransportRejection(thrown)
    ? 'Provider call failed (invalid_request: thinking carriers rejected); message omitted to protect source content'
    : 'Provider call failed; message omitted to protect source content';
  const safe = new Error(message);
  if (thrown instanceof Error) Object.setPrototypeOf(safe, Object.getPrototypeOf(thrown));
  if (typeof source?.name === 'string') safe.name = source.name;
  const classified = safe as ReturnType<typeof sanitizeSurgeryProviderError>;
  if (typeof source?.type === 'string') classified.type = source.type;
  if (typeof source?.httpStatus === 'number') classified.httpStatus = source.httpStatus;
  if (typeof source?.retryable === 'boolean') classified.retryable = source.retryable;
  if (isCompressionWithdrawn(thrown)) Object.defineProperty(safe, Symbol.for('@animalabs/context-manager:compression-withdrawn'), { value: true });
  if (source?.providerAdmission === 'deferred') classified.providerAdmission = 'deferred';
  if (typeof source?.retryAfterMs === 'number') classified.retryAfterMs = source.retryAfterMs;
  if (typeof source?.providerErrorCode === 'string') classified.providerErrorCode = source.providerErrorCode;
  return classified;
}
