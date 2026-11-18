/** Last-resort diagnostics must never create an unobserved rejection/exception. */
export function terminalCatch(report: (error: unknown) => void): (error: unknown) => void {
  return (error) => { try { report(error); } catch { /* Even a host diagnostic sink may throw. */ } };
}
