// Measures the window's write-down, the first presentRows on a branch, which
// writes every stored row into the window index (src/window-index.ts): one
// record for the whole write-down, as context-manager writes it, against one
// record per row, as pre-release builds wrote it before batched writes (a
// stand-in for the batched append below writes it so; context-manager has
// no such path). It also checks that the two leave the same window: the
// same index items, apart from the record each names, the same ordinals and
// the same presented rows.
//
//   npm run build && node bench/window/write-down-bench.mjs [sizes...]
//
// Sizes are message counts (default: 50000). Needs a chronicle with
// appendManyToStateJsonWithIdentity. Numbers are from one synthetic store on
// one machine: use them to compare the two ways of writing, not as a
// guarantee for a resident store, and run it on an idle machine (a busy
// disk makes the per-row leg many times slower).

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, PassthroughStrategy, windowIndexStateId } from '../../dist/src/index.js';

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (sizes.length === 0) sizes.push(50_000);
const INDEX = windowIndexStateId('bench');
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const logMb = (path) => statSync(join(path, 'records.log')).size / 1048576;
const body = (i) => `Message ${i}. ` + 'lorem ipsum dolor sit amet '.repeat(17); // ~470 bytes

async function run(size, perRow) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-window-bench-'));
  const path = join(dir, 'store');
  try {
    let cm = await ContextManager.open({ path, namespace: 'bench', strategy: new PassthroughStrategy() });
    const store = cm.getStore();
    if (typeof store.appendManyToStateJsonWithIdentity !== 'function') {
      console.error('This Chronicle build has no appendManyToStateJsonWithIdentity; nothing to compare.');
      process.exit(1);
    }
    store.setAutoSnapshot(false);
    for (let i = 0; i < size; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: body(i) }]);
    store.setAutoSnapshot(true);
    cm.close();

    // Reference point: a reopen of the history with no window written.
    let t = process.hrtime.bigint();
    cm = await ContextManager.open({ path, namespace: 'bench', strategy: new PassthroughStrategy() });
    cm.getPresentedMessages();
    const legacyReopenMs = ms(t);
    const before = logMb(path);

    // One record per item, as before batched writes: a stand-in for the
    // batched append on this handle. Its ordinal matches no reading, so the
    // index reads the items back from the store.
    if (perRow) {
      cm.getStore().appendManyToStateJsonWithIdentity = function (stateId, items, idField, sequenceField) {
        let record;
        for (const item of items) record = this.appendToStateJsonWithIdentity(stateId, item, idField, sequenceField);
        return { record, firstOrdinal: -1 };
      };
    }
    t = process.hrtime.bigint();
    cm.presentRows([]);
    const writeDownMs = ms(t);
    if (cm.windowMode() !== 'presented') throw new Error('the write-down did not finish');
    const items = cm.getStore().getStateJson(INDEX);
    const records = new Set(items.map((item) => item.by)).size;
    cm.close();
    const logGrowthMb = logMb(path) - before;

    t = process.hrtime.bigint();
    cm = await ContextManager.open({ path, namespace: 'bench', strategy: new PassthroughStrategy() });
    const presented = cm.getPresentedMessages().map((m) => m.id);
    const reopenMs = ms(t);
    const ordinals = presented.map((id) => cm.ordinalOf(id));
    cm.close();
    return {
      writeDownMs, records, logGrowthMb, legacyReopenMs, reopenMs,
      items: items.map(({ at: _at, by: _by, ...item }) => item),
      presented, ordinals,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const size of sizes) {
  const perRow = await run(size, true);
  const batched = await run(size, false);
  if (!same(perRow.items, batched.items)) throw new Error(`${size} rows: the index items differ`);
  if (!same(perRow.presented, batched.presented)) throw new Error(`${size} rows: the presented rows differ`);
  if (!same(perRow.ordinals, batched.ordinals)) throw new Error(`${size} rows: the ordinals differ`);
  if (batched.presented.length !== size) throw new Error(`${size} rows: the window holds ${batched.presented.length}`);
  console.log(`${size} rows: the same ${batched.items.length} items, ordinals and presented rows either way`);
  for (const [name, r] of [['one record per row', perRow], ['one record', batched]]) {
    console.log(
      `  ${name.padEnd(18)} write-down ${r.writeDownMs.toFixed(0).padStart(6)} ms in ${String(r.records).padStart(6)} record(s), ` +
        `log +${r.logGrowthMb.toFixed(1)} MB; reopen ${r.reopenMs.toFixed(0)} ms (${r.legacyReopenMs.toFixed(0)} ms before the write-down)`,
    );
  }
}
