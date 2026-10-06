// Measures what a derived context costs against the size of the history it
// inherits: creation, first read, first write, and memory per extra child.
//
//   npm run build && node --expose-gc bench/derive/derive-bench.mjs [sizes...]
//
// Sizes are message counts (default: 20000 200000). Needs a Chronicle build
// with branch-bound handles (JsStore.view). Numbers are from one synthetic
// store on one machine: use them to compare sizes and candidates, not as a
// guarantee for a mature resident store.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, PassthroughStrategy } from '../../dist/src/index.js';

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (sizes.length === 0) sizes.push(20_000, 200_000);
const CHILDREN = 10;

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc(); } };
const rssMb = () => process.memoryUsage().rss / 1048576;
const heapMb = () => process.memoryUsage().heapUsed / 1048576;
const body = (i) => `Message ${i}. ` + 'lorem ipsum dolor sit amet '.repeat(17); // ~470 bytes

for (const size of sizes) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-derive-bench-'));
  try {
    const parent = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy() });
    const store = parent.getStore();
    if (!ContextManager.supportsDerivation(store)) {
      console.error('This Chronicle build has no JsStore.view; nothing to measure.');
      process.exit(1);
    }
    let t = process.hrtime.bigint();
    store.setAutoSnapshot(false);
    for (let i = 0; i < size; i++) parent.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: body(i) }]);
    store.setAutoSnapshot(true);
    store.compactState('messages');
    const buildMs = ms(t);
    parent.getAllMessages(); // a running agent is warm

    // Reference point: what a cold reopen of the same history costs.
    t = process.hrtime.bigint();
    const cold = store.getStateJson('messages');
    const coldMs = ms(t);
    const coldCount = cold.length;

    gc();
    const before = { rss: rssMb(), heap: heapMb() };
    const derive = [], firstRead = [], firstAppend = [], secondRead = [];
    const children = [];
    for (let n = 0; n < CHILDREN; n++) {
      t = process.hrtime.bigint();
      const child = await parent.derive({ branch: `bench/child-${n}`, strategy: new PassthroughStrategy() });
      derive.push(ms(t));
      t = process.hrtime.bigint();
      const messages = child.getAllMessages();
      firstRead.push(ms(t));
      if (messages.length !== size) throw new Error('child did not inherit the history');
      t = process.hrtime.bigint();
      child.addMessage('User', [{ type: 'text', text: 'child-only' }]);
      firstAppend.push(ms(t));
      t = process.hrtime.bigint();
      child.getAllMessages();
      secondRead.push(ms(t));
      children.push(child);
    }
    gc();
    const after = { rss: rssMb(), heap: heapMb() };

    // The parent keeps working while the children exist.
    t = process.hrtime.bigint();
    parent.addMessage('User', [{ type: 'text', text: 'parent-only' }]);
    parent.getAllMessages();
    const parentTurnMs = ms(t);

    const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(2);
    console.log(JSON.stringify({
      messages: size,
      buildSeconds: +(buildMs / 1000).toFixed(1),
      coldFullReadMs: +coldMs.toFixed(1),
      coldCount,
      deriveMs: { first: +derive[0].toFixed(2), median: +med(derive) },
      childFirstReadMs: { first: +firstRead[0].toFixed(2), median: +med(firstRead) },
      childFirstAppendMs: { first: +firstAppend[0].toFixed(2), median: +med(firstAppend) },
      childReadAfterAppendMs: { median: +med(secondRead) },
      parentAppendAndReadMs: +parentTurnMs.toFixed(2),
      perChildMb: {
        heap: +((after.heap - before.heap) / CHILDREN).toFixed(2),
        rss: +((after.rss - before.rss) / CHILDREN).toFixed(2),
      },
      children: CHILDREN,
    }));
    parent.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
