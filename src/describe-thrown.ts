import type { Diagnostics } from './diagnostics.js';

/**
 * A thrown value as text, for a diagnostic that must not fail in its turn:
 * an Error's message, else the value's String form, else its
 * Object.prototype.toString tag. String() throws on an object with no
 * prototype, and both throw on a revoked Proxy, so a log line built with
 * String(err) could replace the outcome it reports, such as a compile that
 * stands or a write's own error.
 */
export function describeThrown(value: unknown): string {
  try {
    return String(value instanceof Error ? value.message : value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return 'a value that cannot be printed';
    }
  }
}

/**
 * Log `message` with the thrown value as console.error formats it, keeping
 * an Error's stack, without letting the formatting fail in its turn: Node
 * formats an object through its [util.inspect.custom] hook, which can throw.
 * Then the value is described by describeThrown instead. `log` is where the
 * line goes: one namespace's diagnostics name it (#239). `message` is a
 * format string on both paths, since a value follows it on both, so a '%'
 * put into it is doubled first, as diagnostics.ts says.
 */
export function logThrown(message: string, value: unknown, log: Diagnostics = console): void {
  try {
    log.error(message, value);
  } catch {
    log.error(`${message} %s`, describeThrown(value));
  }
}
