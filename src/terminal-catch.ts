/** Last-resort synchronous diagnostics must not throw into a detached continuation.
 * Async sinks are not covered: void-returning reporters may discard their promises. */
export function terminalCatch(report: (error: unknown) => void): (error: unknown) => void {
  return (error) => { try { report(error); } catch { /* Even a host diagnostic sink may throw. */ } };
}
