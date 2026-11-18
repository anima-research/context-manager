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
  if (typeof source?.name === 'string') Object.defineProperty(safe, 'name', { value: source.name, configurable: true, writable: true });
  const classified = safe as ReturnType<typeof sanitizeSurgeryProviderError>;
  if (typeof source?.type === 'string') Object.defineProperty(safe, 'type', { value: source.type, enumerable: true, configurable: true, writable: true });
  if (typeof source?.httpStatus === 'number') Object.defineProperty(safe, 'httpStatus', { value: source.httpStatus, enumerable: true, configurable: true, writable: true });
  if (typeof source?.retryable === 'boolean') Object.defineProperty(safe, 'retryable', { value: source.retryable, enumerable: true, configurable: true, writable: true });
  if (isCompressionWithdrawn(thrown)) Object.defineProperty(safe, Symbol.for('@animalabs/context-manager:compression-withdrawn'), { value: true });
  if (source?.providerAdmission === 'deferred') Object.defineProperty(safe, 'providerAdmission', { value: 'deferred', enumerable: true, configurable: true, writable: true });
  if (typeof source?.retryAfterMs === 'number') Object.defineProperty(safe, 'retryAfterMs', { value: source.retryAfterMs, enumerable: true, configurable: true, writable: true });
  if (typeof source?.providerErrorCode === 'string') Object.defineProperty(safe, 'providerErrorCode', { value: source.providerErrorCode, enumerable: true, configurable: true, writable: true });
  return classified;
}
