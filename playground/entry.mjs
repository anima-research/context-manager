// Browser entry for the best-fit playground — re-exports only the solver
// subgraph (no chunker / node:crypto), so it bundles clean for the browser.
export { SummaryTree, nodeTokens } from '../dist/src/adaptive/summary-tree.js';
export { renderLayout, kvCost, earliestDivergenceIndex } from '../dist/src/adaptive/render-offsets.js';
export { ValueFunction } from '../dist/src/adaptive/value-function.js';
export { solveFrontier } from '../dist/src/adaptive/best-fit-solver.js';
export { solveStableFrontier } from '../dist/src/adaptive/stable-frontier.js';
export { placeMarkers, evaluateCacheHit } from '../dist/src/adaptive/kv-cache-sim.js';
export { replaySession } from '../dist/src/adaptive/kv-replay.js';
export { replayControlled } from '../dist/src/adaptive/kv-control.js';
