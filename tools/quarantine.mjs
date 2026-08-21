/**
 * quarantine — inspect (and optionally drain) an agent's compression
 * quarantine, using the strategy's OWN accounting.
 *
 * Replaces the ad-hoc scripts/quarantine-inspect.mjs, which re-implemented the
 * ledger projection and got it wrong: it counted events of kind 'claim', but
 * records are written as kind 'exhausted', so it reported "ACTIVE: 0" while
 * ~80 chunks were genuinely quarantined (mythos, 2026-08-21 — an instrument
 * reading absence where there was debt). The fix is to never re-derive the
 * projection here: call AutobiographicalStrategy.getCompressionQuarantineStatus(),
 * the same method the live klaxon uses, so the tool cannot drift from the code.
 *
 * `getStats()` here also reports pending chunks, and getCompressionQuarantine-
 * Status runs the paid-off sweep on open, so the count reflects REAL debt
 * (spans not yet compressed / not orphaned), not stale records.
 *
 * Read-only by default. --clear invokes the supported operator escape hatch
 * (clearCompressionRefusalQuarantine) — it only permits the same request
 * family to be retried; anything that still refuses simply re-quarantines.
 *
 * Run with the agent STOPPED (chronicle single-writer lock) or against a copy
 * (copies can't be cleared meaningfully — clear needs the live store).
 *
 * Usage:
 *   node quarantine.mjs <storePath> [--ns agents/<name>] [--clear] [--json]
 *
 * Exit: 0 = empty, 2 = debt present (and not cleared), 1 = error.
 */
import { ContextManager, AutobiographicalStrategy } from "@animalabs/context-manager";

const STORE = process.argv[2];
if (!STORE || STORE.startsWith("--")) {
  console.error("usage: node quarantine.mjs <storePath> [--ns agents/<name>] [--clear] [--json]");
  process.exit(1);
}
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const CLEAR = process.argv.includes("--clear");
const JSON_OUT = process.argv.includes("--json");

// Namespace: default to agents/mythos, but let the store correct us — the
// strategy is opened under whatever namespace we pass; if it has no summaries
// there, warn.
const ns = arg("--ns", "agents/mythos");

const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
const m = await ContextManager.open({ path: STORE, strategy, namespace: ns });
const store = m.getStore();
const branch = store.currentBranch().name;

const status = strategy.getCompressionQuarantineStatus();   // runs the paid-off sweep, real debt
const st = strategy.getStats();
const pending = st.chunksTotal - st.chunksCompressed;

if (JSON_OUT && !CLEAR) {
  console.log(JSON.stringify({ branch, ns, quarantined: status.count, keys: status.keys, chunksTotal: st.chunksTotal, chunksCompressed: st.chunksCompressed, pending }, null, 1));
  process.exit(status.count > 0 ? 2 : 0);
}

console.error(`branch: ${branch}   ns: ${ns}`);
console.error(`chunks: ${st.chunksCompressed}/${st.chunksTotal} compressed   pending: ${pending}`);
console.error(`quarantined chunks (real debt): ${status.count}`);
if (status.count) console.error(`keys: ${status.keys.map((k) => k.slice(0, 12)).join(",")}`);

if (!CLEAR) {
  process.exit(status.count > 0 ? 2 : 0);
}

if (status.count === 0) { console.error("nothing to clear."); process.exit(0); }
await strategy.clearCompressionRefusalQuarantine();   // no key = clear all (operator escape hatch)
const after = strategy.getCompressionQuarantineStatus();
const st2 = strategy.getStats();
store.sync();
console.error(`cleared: ${status.count} -> ${after.count}; pending now: ${st2.chunksTotal - st2.chunksCompressed}; synced.`);
console.error("note: restart the agent so it recompresses the freed chunks through the live path.");
process.exit(0);
