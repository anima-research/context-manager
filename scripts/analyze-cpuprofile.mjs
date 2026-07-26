#!/usr/bin/env node
// Aggregate a V8 .cpuprofile: top functions by SELF time and by TOTAL time
// (total = self + children, computed over the node tree, deduped per stack).
// Usage: node scripts/analyze-cpuprofile.mjs <file.cpuprofile> [topN]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const topN = Number(process.argv[3] ?? 30);
const p = JSON.parse(readFileSync(file, 'utf8'));

const nodes = new Map(p.nodes.map((n) => [n.id, n]));
// sample counts per node
const hits = new Map();
for (const id of p.samples) hits.set(id, (hits.get(id) ?? 0) + 1);
const totalSamples = p.samples.length;
const durUs = p.endTime - p.startTime;
const usPerSample = durUs / totalSamples;

const keyOf = (n) => {
  const f = n.callFrame;
  const url = (f.url ?? '').replace(/^file:\/\//, '').split('/').slice(-3).join('/');
  return `${f.functionName || '(anon)'} ${url}:${f.lineNumber + 1}`;
};

// self time per function key
const self = new Map();
for (const [id, c] of hits) {
  const n = nodes.get(id);
  if (!n) continue;
  const k = keyOf(n);
  self.set(k, (self.get(k) ?? 0) + c);
}

// total time per function key: walk tree, accumulate subtree samples; count a
// key once per root-most occurrence on a path to avoid double-counting recursion.
const children = new Map();
for (const n of p.nodes) children.set(n.id, n.children ?? []);
const subtree = new Map();
function computeSubtree(id) {
  if (subtree.has(id)) return subtree.get(id);
  let s = hits.get(id) ?? 0;
  for (const c of children.get(id) ?? []) s += computeSubtree(c);
  subtree.set(id, s);
  return s;
}
const roots = p.nodes.filter((n) => !p.nodes.some((m) => (m.children ?? []).includes(n.id)));
for (const r of roots) computeSubtree(r.id);
const total = new Map();
function walk(id, seen) {
  const n = nodes.get(id);
  if (!n) return;
  const k = keyOf(n);
  const isNew = !seen.has(k);
  if (isNew) {
    total.set(k, (total.get(k) ?? 0) + subtree.get(id));
    seen = new Set(seen).add(k);
  }
  for (const c of children.get(id) ?? []) walk(c, seen);
}
for (const r of roots) walk(r.id, new Set());

const ms = (samples) => ((samples * usPerSample) / 1000).toFixed(1);
const pct = (samples) => ((samples / totalSamples) * 100).toFixed(1);

console.log(`profile: ${file}`);
console.log(`duration ${(durUs / 1e6).toFixed(2)} s, ${totalSamples} samples (~${(usPerSample / 1000).toFixed(2)} ms/sample)\n`);
console.log(`== TOP ${topN} BY SELF TIME ==`);
for (const [k, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  console.log(`${pct(c).padStart(6)}%  ${ms(c).padStart(10)} ms  ${k}`);
}
console.log(`\n== TOP ${topN} BY TOTAL TIME (self+children) ==`);
for (const [k, c] of [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  console.log(`${pct(c).padStart(6)}%  ${ms(c).padStart(10)} ms  ${k}`);
}
