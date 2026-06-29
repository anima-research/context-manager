/**
 * Phase channel — a process-wide observability hook for labelling the
 * synchronous operation the main thread is currently running.
 *
 * Long synchronous work (context assembly, compression, merge-graph walks) can
 * wedge the single-threaded event loop. An external liveness watchdog (in the
 * host/agent-framework) can detect the wedge but not name what was running —
 * unless the running code labels itself here. This module is a no-op sink by
 * default; the watchdog installs `report` on start so labels reach its wedge
 * report. context-manager owns the channel (no upward dependency); the watchdog
 * (which depends on context-manager) wires it.
 */
const stack: string[] = [];

export const phaseChannel: {
  /** Installed by the watchdog; receives the current (innermost) phase label. */
  report: (label: string) => void;
} = {
  report: () => {},
};

/** Enter a named phase. Returns a disposer that restores the previous phase. */
export function enterPhase(label: string): () => void {
  stack.push(label);
  phaseChannel.report(label);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // Pop this label (tolerate out-of-order disposal defensively).
    const idx = stack.lastIndexOf(label);
    if (idx !== -1) stack.splice(idx, 1);
    phaseChannel.report(stack[stack.length - 1] ?? 'idle');
  };
}

/** Run a synchronous section under a phase label (nesting-safe). */
export function withPhase<T>(label: string, fn: () => T): T {
  const leave = enterPhase(label);
  try {
    return fn();
  } finally {
    leave();
  }
}

/** Run an async section under a phase label. Note: this labels across awaits,
 *  which is what we want — the synchronous spans inside (where a wedge would
 *  occur) stay attributed to this phase. */
export async function withPhaseAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const leave = enterPhase(label);
  try {
    return await fn();
  } finally {
    leave();
  }
}
