/** Observe the drain's actual then/catch continuation, not an event-loop delay. */
export function observeDrainCompletion<T>(tick: Promise<T>, completions: Promise<unknown>[]): Promise<T> {
  const then = tick.then.bind(tick);
  // driveSpeculativeDrain explicitly installs then(...).catch(...). Tracking
  // that terminal promise includes asynchronous work added inside either arm.
  Object.defineProperty(tick, 'then', { configurable: true, value(...args: Parameters<typeof then>) {
    const continuation = then(...args);
    const caught = continuation.catch.bind(continuation);
    Object.defineProperty(continuation, 'catch', { configurable: true, value(...handlers: Parameters<typeof caught>) {
      const terminal = caught(...handlers);
      completions.push(terminal);
      return terminal;
    } });
    return continuation;
  } });
  return tick;
}
