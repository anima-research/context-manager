// Browser entry for the best-fit playground — re-exports only the solver
// subgraph (no chunker / node:crypto), so it bundles clean for the browser.
export { SummaryTree, nodeTokens } from '../dist/src/adaptive/summary-tree.js';
export { renderLayout, kvCost, earliestDivergenceIndex } from '../dist/src/adaptive/render-offsets.js';
export { placeMarkers, evaluateCacheHit } from '../dist/src/adaptive/kv-cache-sim.js';
export { planControlledFrontier, replayControlled } from '../dist/src/adaptive/kv-control.js';
export { replaySession } from '../dist/src/adaptive/kv-replay.js';
