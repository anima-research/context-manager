/**
 * tree-doctor — audit an agent's autobiographical summary tree for the
 * non-nested / double-representation defect that the kv-control picker only
 * warns about at compile time ("[kv-overlap] ⚠️ non-nested summary tree").
 *
 * That warning is CORRECT but terse: it prints a count and 5 sample leaf ids,
 * with no way to see whether it is a real conflict (two live lineages over one
 * span) or an absence (a leaf with no ancestor at that level), nor which nodes
 * are involved. This tool reconstructs the tree from the store and reports it
 * precisely — and gives a clean exit code so a repair can be verified against
 * it (0 = healthy, 2 = conflicts found).
 *
 * Motivated by the 2026-08-21 mythos incident, where the same question cost
 * three throwaway scripts and a wrong "it's spurious" conclusion before the
 * data showed 8 genuine conflicts / 0 false positives.
 *
 * Runs directly on the store (read-only, no API). The agent must be STOPPED
 * or you must point it at a copy (chronicle single-writer lock).
 *
 * Usage:
 *   node tree-doctor.mjs <storePath> [--ns agents/<name>] [--examples N] [--json]
 *
 * Exit: 0 = no conflicts, 2 = conflicts found, 1 = error.
 */
const STORE = process.argv[2];
if (!STORE || STORE.startsWith("--")) {
  console.error("usage: node tree-doctor.mjs <storePath> [--ns agents/<name>] [--examples N] [--json]");
  process.exit(1);
}
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const EXAMPLES = Number(arg("--examples", "8"));
const JSON_OUT = process.argv.includes("--json");

// Resolve chronicle the way the store's own code does: from this file's tree.
const CHR = new URL("../node_modules/@animalabs/chronicle/index.js", import.meta.url);
const { JsStore } = await import(CHR.href);

const store = JsStore.open({ path: STORE });
const branch = store.currentBranch().name;

// Auto-detect the namespace (…/autobio:summaries) unless --ns given.
// Several namespaces can carry the slot (e.g. an empty `default/` alongside
// the live `agents/<name>/`); pick the one whose summaries slot is largest.
let ns = arg("--ns", null);
if (!ns) {
  const states = store.listStates().map((x) => (typeof x === "string" ? x : x.id || x.name));
  const cands = states.map(String).filter((id) => id.endsWith("autobio:summaries"));
  if (!cands.length) { console.error("no …/autobio:summaries state found; pass --ns"); process.exit(1); }
  let best = null, bestN = -1;
  for (const id of cands) {
    const v = store.getStateJson(id);
    const arr = typeof v === "string" ? JSON.parse(v) : v;
    const n = Array.isArray(arr) ? arr.length : 0;
    if (n > bestN) { bestN = n; best = id; }
  }
  ns = best.replace(/\/autobio:summaries$/, "");
  if (cands.length > 1) console.error(`# ns auto-selected: ${ns} (${bestN} summaries; candidates: ${cands.join(", ")})`);
}
const g = (slot) => { const v = store.getStateJson(`${ns}/${slot}`); return typeof v === "string" ? JSON.parse(v) : v; };

const sums = g("autobio:summaries") || [];
const byId = new Map(sums.map((x) => [String(x.id), x]));
const parentOf = new Map();
for (const su of sums) if (su.mergedInto != null) parentOf.set(String(su.id), String(su.mergedInto));

// leaf chunk -> its L1 summary; and which L1s cover each chunk (dup detection)
const l1OfChunk = new Map();
const coverCount = new Map();
for (const su of sums) {
  if (Number(su.level) !== 1) continue;
  for (const c of su.sourceIds || []) {
    const k = String(c);
    l1OfChunk.set(k, String(su.id));          // last writer wins for "the" L1
    coverCount.set(k, (coverCount.get(k) || 0) + 1);
  }
}
const ancestorAt = (chunkId, level) => {
  let cur = l1OfChunk.get(String(chunkId));
  while (cur) {
    const n = byId.get(cur);
    if (!n) return null;
    const l = Number(n.level);
    if (l === level) return cur;
    if (l > level) return null;
    cur = parentOf.get(cur);
  }
  return null;
};
const coveredLeaves = (nodeId, seen = new Set()) => {
  const n = byId.get(String(nodeId));
  if (!n) return [];
  if (Number(n.level) === 1) return (n.sourceIds || []).map(String);
  const out = [];
  for (const src of n.sourceIds || []) {
    const k = String(src);
    if (seen.has(k)) continue; seen.add(k);
    if (byId.has(k)) out.push(...coveredLeaves(k, seen)); else out.push(k);
  }
  return out;
};

// Level histogram + token estimate
const byLevel = {}, tokByLevel = {};
for (const su of sums) {
  const L = su.level ?? "?";
  byLevel[L] = (byLevel[L] || 0) + 1;
  const t = typeof su.tokens === "number" ? su.tokens : Math.ceil(String(su.content || "").length / 4);
  tokByLevel[L] = (tokByLevel[L] || 0) + t;
}

// The audit: for every node claiming a leaf, does the leaf's own lineage agree?
let ok = 0, absence = 0, conflict = 0;
const conflicts = [];
for (const su of sums) {
  const lvl = Number(su.level);
  if (lvl < 2) continue;
  for (const leaf of coveredLeaves(su.id)) {
    const own = ancestorAt(leaf, lvl);
    if (own === String(su.id)) ok++;
    else if (own == null) absence++;
    else { conflict++; if (conflicts.length < 1000) conflicts.push({ leaf, claimedBy: String(su.id), ownAncestor: own, level: lvl }); }
  }
}
const dupChunks = [...coverCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);

if (JSON_OUT) {
  console.log(JSON.stringify({ branch, ns, summaries: sums.length, byLevel, ok, absence, conflict, dupChunks: dupChunks.length, conflicts: conflicts.slice(0, 50) }, null, 1));
} else {
  console.log(`branch: ${branch}   ns: ${ns}   summaries: ${sums.length}`);
  console.log("levels:", Object.entries(byLevel).map(([l, c]) => `L${l}=${c}`).join(" "),
              "| tokens:", Object.entries(tokByLevel).map(([l, t]) => `L${l}=${t}`).join(" "));
  console.log("\nclaim-vs-lineage audit:");
  console.log(`  consistent : ${ok}`);
  console.log(`  ABSENCE    : ${absence}   (claimed, leaf has NO ancestor at that level)`);
  console.log(`  CONFLICT   : ${conflict}   (claimed, leaf's lineage names a DIFFERENT node)`);
  console.log(`  chunks double-covered by >1 L1: ${dupChunks.length}`);
  if (conflict) {
    // group conflicts by (claimedBy -> ownAncestor) pair to name the culprit nodes
    const pairs = new Map();
    for (const c of conflicts) {
      const key = `L${c.level}: ${c.claimedBy}  vs  ${c.ownAncestor}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(c.leaf);
    }
    console.log("\noverlapping node pairs (claimer vs true owner):");
    for (const [pair, leaves] of pairs) {
      console.log(`  ${pair}   over ${leaves.length} chunk(s): ${leaves.slice(0, EXAMPLES).join(",")}${leaves.length > EXAMPLES ? "…" : ""}`);
    }
    console.log("\nVERDICT: non-nested tree — needs nesting repair.");
  } else {
    console.log("\nVERDICT: tree is well-nested. ✓");
  }
}
process.exit(conflict > 0 ? 2 : 0);
