// Measures the read of the window index that follows another handle's write
// to it (src/window-index.ts, WindowIndex.current): two managers on one
// store and namespace, where one presents a row and the other then reads the
// index. The reader takes only the items appended since its last reading
// (readOn), or, with chronicle's getStateSlice hidden from it, reads the
// index whole, as before that read. It checks that both readers end with the
// same window as the writer.
//
//   npm run build && node bench/window/reload-bench.mjs [sizes...]
//
// Sizes are index items (default: 1000 10000 50000), written straight to
// the index as presentations, in records of 50, so no message is stored for
// them. Numbers are from one synthetic store on one machine: use them to
// compare the two reads, not as a guarantee for a resident store. It prints
// the Node version and the chronicle it loaded before its results: name
// both with any figures quoted from it.

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ContextManager, PassthroughStrategy, windowIndexStateId } from '../../dist/src/index.js';

const chronicleDir = dirname(realpathSync(createRequire(import.meta.url).resolve('@animalabs/chronicle')));
const chronicleVersion = JSON.parse(readFileSync(join(chronicleDir, 'package.json'), 'utf8')).version;
console.log(`node ${process.version}; @animalabs/chronicle ${chronicleVersion}, loaded from ${chronicleDir}`);

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (sizes.length === 0) sizes.push(1_000, 10_000, 50_000);
const TURNS = 100;
const INDEX = windowIndexStateId('bench');
const text = (t) => [{ type: 'text', text: t }];

async function run(size, whole) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-window-reload-'));
  try {
    const writer = await ContextManager.open({ path: join(dir, 'store'), namespace: 'bench', strategy: new PassthroughStrategy() });
    const store = writer.getStore();
    const reader = await ContextManager.open({ store, namespace: 'bench', strategy: new PassthroughStrategy() });
    writer.presentRows([]);
    for (let i = 0; i < size; i += 50) {
      const items = Array.from({ length: Math.min(50, size - i) }, (_, k) => ({ id: `bench-row-${i + k}` }));
      store.appendManyToStateJsonWithIdentity(INDEX, items, 'by', 'at');
    }
    if (whole) store.getStateSlice = undefined;
    const rows = Array.from({ length: TURNS }, (_, i) => writer.addMessage('bench', text(`turn ${i}`)));
    reader.indexLength();
    writer.indexLength();
    let ns = 0n;
    for (const id of rows) {
      writer.presentRows([id]);
      const start = process.hrtime.bigint();
      reader.indexLength();
      ns += process.hrtime.bigint() - start;
    }
    const same = writer.getPresentedMessages().map((m) => m.id).join() === reader.getPresentedMessages().map((m) => m.id).join();
    reader.close();
    writer.close();
    return { us: Number(ns) / TURNS / 1000, same };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const size of sizes) {
  const whole = await run(size, true);
  const since = await run(size, false);
  console.log(
    `${size} items: read whole ${whole.us.toFixed(0)} µs, read since the last reading ${since.us.toFixed(1)} µs ` +
      `(per read after another handle's write, ${TURNS} reads; same window: ${whole.same && since.same})`,
  );
}
