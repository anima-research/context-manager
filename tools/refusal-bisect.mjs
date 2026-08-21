/**
 * refusal-bisect — find the minimal trigger in a refused inference request and
 * map it back to the store object that carries it.
 *
 * Every refusal incident this year followed the same shape — a specific object
 * in the payload trips the classifier — but each was investigated with bespoke
 * throwaway scripts: June (rendered thinking paragraphs), July (a mislabeled
 * SVG; a live #manykins tail), August (an AES-cryptanalysis paper screenshot).
 * This makes that investigation first-class and MEDIA-AWARE: it ablates the
 * request, isolates the culprit(s), and — for image culprits — resolves the
 * blob hash to its source message id / participant / branch in the store.
 *
 * The classifier is PROBABILISTIC near threshold (a request can refuse live and
 * pass on replay), so every arm is drawn N times and reported as a rate.
 *
 * Usage:
 *   node refusal-bisect.mjs --req <req.json | llm-calls.jsonl> [--store <path>]
 *        [--draws N] [--max-tokens M] [--key-from <.env>]
 *
 *   --req         a saved rawRequest JSON, or an llm-calls.*.jsonl (uses its
 *                 LAST refusal record's rawRequest)
 *   --store       chronicle store dir, to map image culprits -> source message
 *   --draws       replays per arm (default 3; classifier is probabilistic)
 *   --max-tokens  response cap per replay (default 64 — we only need stop_reason)
 *   --key-from    file to read ANTHROPIC_API_KEY= from (default: env, then
 *                 <store>/../.env if --store given)
 *
 * API calls: 1 full + 1 per distinct image, times --draws. Small max_tokens.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const REQ = opt("--req");
const STORE = opt("--store");
const DRAWS = Number(opt("--draws", "3"));
const MAX_TOKENS = Number(opt("--max-tokens", "64"));
if (!REQ) { console.error("usage: refusal-bisect.mjs --req <req.json|llm-calls.jsonl> [--store <path>] [--draws N]"); process.exit(1); }

// ---- API key ----
function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const files = [opt("--key-from"), STORE && `${STORE}/../../.env`, STORE && `${STORE}/../.env`].filter(Boolean);
  for (const f of files) {
    try {
      const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY="));
      if (line) return line.split("=", 2)[1].trim();
    } catch {}
  }
  return null;
}
const KEY = readKey();   // required only for replay arms; --enumerate-only needs none

// ---- load the request ----
function loadRequest(path) {
  const txt = readFileSync(path, "utf8");
  if (path.endsWith(".json") && !path.includes("llm-calls")) return JSON.parse(txt);
  // llm-calls: stream lines, keep the last refusal's rawRequest
  let last = null;
  for (const line of txt.split("\n")) {
    if (!line.startsWith("{")) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r?.rawResponse?.stop_reason === "refusal" && r?.rawRequest) last = r.rawRequest;
  }
  if (!last) throw new Error("no refusal record with a rawRequest found in " + path);
  return last;
}
const baseReq = loadRequest(REQ);

// ---- sanitize a message list for replay (strip cache_control, end on user) ----
function prep(messages) {
  const m = structuredClone(messages);
  for (const msg of m) if (Array.isArray(msg.content)) for (const b of msg.content) delete b.cache_control;
  while (m.length && m[m.length - 1].role !== "user") m.pop();
  return m;
}
function bodyOf(messages) {
  const body = {};
  for (const k of ["model", "system", "tools", "tool_choice", "thinking"]) if (baseReq[k] !== undefined) body[k] = baseReq[k];
  body.messages = prep(messages);
  body.stream = false;
  body.max_tokens = MAX_TOKENS;
  return body;
}
async function callOnce(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(bodyOf(messages)),
  });
  if (!res.ok) { const t = await res.text(); return { stop: `HTTP_${res.status}`, cat: t.slice(0, 80) }; }
  const j = await res.json();
  return { stop: j.stop_reason, cat: (j.stop_details || {}).category ?? null };
}
async function arm(label, messages) {
  let refuse = 0, cat = null;
  for (let i = 0; i < DRAWS; i++) {
    const r = await callOnce(messages);
    if (r.stop === "refusal") { refuse++; cat = r.cat; }
  }
  const pass = DRAWS - refuse;
  console.log(`  ${refuse}/${DRAWS} refuse${cat ? " (" + cat + ")" : ""}   ${refuse === 0 ? "PASS" : refuse === DRAWS ? "REFUSE" : "FLAKY"}   ${label}`);
  return { label, refuse, pass, cat };
}

// ---- enumerate distinct images with their positions ----
const images = [];
baseReq.messages.forEach((msg, mi) => {
  if (!Array.isArray(msg.content)) return;
  msg.content.forEach((b, bi) => {
    if (b.type === "image" && b.source?.type === "base64") {
      const hash = createHash("sha256").update(Buffer.from(b.source.data, "base64")).digest("hex");
      images.push({ mi, bi, hash, kb: Math.round((b.source.data.length * 3) / 4 / 1024) });
    }
  });
});
const distinct = [...new Map(images.map((x) => [x.hash, x])).values()];

console.log(`request: ${baseReq.messages.length} messages, ${images.length} image block(s) (${distinct.length} distinct)`);

// ---- store mapping helper (also used by --enumerate-only) ----
async function mapHashesToMessages(hashes) {
  if (!STORE) return null;
  const CHR = new URL("../node_modules/@animalabs/chronicle/index.js", import.meta.url);
  const { JsStore } = await import(CHR.href);
  const s = JsStore.open({ path: STORE });
  const branch = s.currentBranch().name;
  const v = s.getStateJson("messages");
  const arr = typeof v === "string" ? JSON.parse(v) : v;
  const wanted = new Set(hashes);
  const out = [];
  for (const m of arr) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "blob_ref" && wanted.has(b.ref?.hash)) {
        const tx = m.content.filter((x) => x.type === "text").map((x) => x.text).join(" ").slice(0, 80).replace(/\n/g, " ");
        out.push({ hash: b.ref.hash, id: m.id, participant: m.participant, text: tx });
      }
    }
  }
  return { branch, rows: out };
}

// ---- --enumerate-only: no API calls; list images and map to source ----
if (argv.includes("--enumerate-only") || argv.includes("--map")) {
  console.log("\ndistinct images:");
  for (const img of distinct) console.log(`  ${img.hash.slice(0, 12)}  ${String(img.kb).padStart(5)}KB  msg[${img.mi}]`);
  if (STORE) {
    const mapped = await mapHashesToMessages(distinct.map((d) => d.hash));
    console.log(`\nsource messages on branch ${mapped.branch}:`);
    for (const r of mapped.rows) console.log(`  ${r.hash.slice(0, 12)} -> id=${r.id} participant=${r.participant} :: ${JSON.stringify(r.text)}`);
    const found = new Set(mapped.rows.map((r) => r.hash));
    const orphan = distinct.filter((d) => !found.has(d.hash));
    if (orphan.length) console.log(`  (${orphan.length} image(s) not in the live 'messages' state — likely folded/other branch: ${orphan.map((o) => o.hash.slice(0, 8)).join(",")})`);
  } else {
    console.log("(pass --store to map these to source messages)");
  }
  process.exit(0);
}
if (!KEY) { console.error("\nno ANTHROPIC_API_KEY for replay (env, --key-from, or <store>/.env). Use --enumerate-only for no-API mapping."); process.exit(1); }
console.log(`draws/arm: ${DRAWS}\n`);

// ---- baseline ----
console.log("baseline:");
const base = await arm("full request", baseReq.messages);
if (base.refuse === 0) {
  console.log("\nfull request does NOT reproduce the refusal (near-threshold / cold-rescore artifact). Increase --draws or capture a fresher request.");
}

// ---- strip-all-images ----
function stripImages(messages, hashesToStrip /* Set | null = all */) {
  const m = structuredClone(messages);
  for (const msg of m) if (Array.isArray(msg.content)) {
    msg.content = msg.content.map((b) => {
      if (b.type !== "image" || b.source?.type !== "base64") return b;
      const h = createHash("sha256").update(Buffer.from(b.source.data, "base64")).digest("hex");
      if (!hashesToStrip || hashesToStrip.has(h)) return { type: "text", text: "[image omitted for bisect]" };
      return b;
    });
  }
  return m;
}

let culprits = [];
if (distinct.length) {
  console.log("\nimage ablation (strip one image, does it flip to PASS?):");
  const noAll = await arm("strip ALL images", stripImages(baseReq.messages, null));
  if (noAll.refuse < base.refuse) {
    for (const img of distinct) {
      const r = await arm(`strip ${img.hash.slice(0, 8)} (${img.kb}KB, msg[${img.mi}])`, stripImages(baseReq.messages, new Set([img.hash])));
      if (r.refuse === 0 && base.refuse > 0) culprits.push(img);
    }
  } else {
    console.log("  removing all images did not reduce refusals — the trigger is NOT an image (try message-range bisect: --draws higher, inspect text).");
  }
}

// ---- coarse message-range bisect (fallback for text triggers) ----
if (!culprits.length && base.refuse > 0) {
  console.log("\nmessage-range bisect (halves):");
  const n = baseReq.messages.length;
  const mid = Math.floor(n / 2);
  await arm(`first half [0:${mid}]`, baseReq.messages.slice(0, mid));
  await arm(`second half [${mid}:${n}]`, baseReq.messages.slice(mid));
  console.log("  (narrow further by re-running --req on a saved slice; text-trigger localization is manual for now)");
}

// ---- map image culprits to store objects ----
if (culprits.length) {
  console.log(`\nCULPRIT(S): ${culprits.map((c) => c.hash.slice(0, 12)).join(", ")}`);
  if (STORE) {
    try {
      const CHR = new URL("../node_modules/@animalabs/chronicle/index.js", import.meta.url);
      const { JsStore } = await import(CHR.href);
      const s = JsStore.open({ path: STORE });
      const branch = s.currentBranch().name;
      const states = s.listStates().map((x) => (typeof x === "string" ? x : x.id || x.name));
      const msgState = states.find((id) => id === "messages") || "messages";
      const v = s.getStateJson(msgState);
      const arr = typeof v === "string" ? JSON.parse(v) : v;
      const wanted = new Set(culprits.map((c) => c.hash));
      console.log(`\nsource messages on branch ${branch}:`);
      for (const m of arr) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type === "blob_ref" && wanted.has(b.ref?.hash)) {
            const tx = m.content.filter((x) => x.type === "text").map((x) => x.text).join(" ").slice(0, 80).replace(/\n/g, " ");
            console.log(`  ${b.ref.hash.slice(0, 12)} -> message id=${m.id} participant=${m.participant} :: ${JSON.stringify(tx)}`);
          }
        }
      }
      console.log(`\nremedy: strike/omit these blob_refs (e.g. strike-image-message by the discord id in the message metadata), then clear the affected quarantine.`);
    } catch (e) {
      console.log(`(store mapping failed: ${e.message} — pass a copy or stop the agent)`);
    }
  } else {
    console.log("pass --store <path> to resolve these hashes to source messages.");
  }
} else if (base.refuse > 0) {
  console.log("\nno single image is the sole culprit — likely cumulative mass across multiple items (see the halves above).");
}
