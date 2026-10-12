import type { JsStore } from '@animalabs/chronicle';

/**
 * Whether `error` is Chronicle's answer to registering a slot that already
 * exists, for this slot.
 *
 * Chronicle answers a duplicate registration with a generic N-API Error and no
 * distinct code, by id alone, whatever strategy or cadence the slot was first
 * registered with. So its complete message is matched, for this slot only.
 * Every registration in this package treats that as the slot being registered
 * already, and nothing else: an I/O failure, a closed store or a malformed id
 * propagates to the caller.
 */
export function isStateExistsFor(error: unknown, stateId: string): boolean {
  return error instanceof Error && error.message === `State already exists: ${stateId}`;
}

/**
 * Register a Chronicle state slot, keeping it as it is if it already exists.
 * Any other registration failure propagates. Returns whether this call
 * registered the slot.
 */
export function registerStateIfAbsent(
  store: JsStore,
  registration: Parameters<JsStore['registerState']>[0],
): boolean {
  try {
    store.registerState(registration);
    return true;
  } catch (error) {
    if (isStateExistsFor(error, registration.id)) return false;
    throw error;
  }
}
