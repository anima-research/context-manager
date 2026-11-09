/**
 * The image ceilings (imageCeiling, imageByteCeiling): the most images, and
 * their bytes, a strategy's live window keeps, and the most
 * images and bytes a compression prompt carries. The live window keeps its
 * own limits within them, compression prompts carry no more than them, and
 * imageCeilings() reports them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, WindowedPassthroughStrategy } from '../src/index.js';
import type { ContextStrategy, ImageCeilings } from '../src/index.js';
import { ceilingBoundLine, resolveLiveImageLimits } from '../src/live-image-limits.js';

const MiB = 1024 * 1024;
const PLACEHOLDER = '[image not shown: this context keeps only some images]';
/** What every ceiling line says, and no other line. */
const CEILING_LINE = 'so some images are now shown as placeholders';

/** A message holding one image of `bytes` base64 characters and a label. */
const imageMessage = (label: string, bytes = 4): ContentBlock[] => [
  { type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes), mediaType: 'image/png' }, tokenEstimate: 100 } as ContentBlock,
  { type: 'text', text: label },
];

/** Which of img-1..n kept its image ('I'), was stripped ('.') or is missing ('-'). */
function pattern(messages: Array<{ content: ContentBlock[] }>, n: number): string {
  let out = '';
  for (let i = 1; i <= n; i++) {
    const m = messages.find((x) => x.content.some((b) => b.type === 'text' && b.text === `img-${i}`));
    out += !m ? '-' : m.content.some((b) => b.type === 'image') ? 'I' : '.';
  }
  return out;
}

/** Compile a fresh store holding `n` image messages of `bytes` each. */
async function compiled(strategy: ContextStrategy, n: number, bytes = 4): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  try {
    for (let i = 1; i <= n; i++) manager.addMessage('user', imageMessage(`img-${i}`, bytes));
    const result = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    return pattern(result.messages, n);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const memory = (options: Record<string, unknown>) => new AutobiographicalStrategy({
  headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, ...options,
} as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
const windowed = (options: Record<string, unknown>) => new WindowedPassthroughStrategy({
  imageStripDepthTokens: 0, ...options,
} as ConstructorParameters<typeof WindowedPassthroughStrategy>[0]);
const STRATEGIES = { autobiographical: memory, 'windowed passthrough': windowed };
const DEFAULTS = {
  autobiographical: () => new AutobiographicalStrategy(),
  'windowed passthrough': () => new WindowedPassthroughStrategy(),
};

describe('imageCeilings()', () => {
  it('is reachable through the ContextStrategy interface, typed by the exported ImageCeilings', () => {
    const strategy: ContextStrategy = new WindowedPassthroughStrategy();
    const ceilings: ImageCeilings | undefined = strategy.imageCeilings?.();
    assert.deepEqual(ceilings, { imageCeiling: 500, imageByteCeiling: 24 * MiB });
  });

  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: the defaults are 500 images and 24 MiB`, () => {
      assert.deepEqual(DEFAULTS[name as keyof typeof DEFAULTS]().imageCeilings(), { imageCeiling: 500, imageByteCeiling: 24 * MiB });
    });

    it(`${name}: reports the ceilings as the window applies them`, () => {
      const ceilings = (options: Record<string, unknown>) => make(options).imageCeilings();
      assert.deepEqual(ceilings({ imageCeiling: 10, imageByteCeiling: 2 * MiB }), { imageCeiling: 10, imageByteCeiling: 2 * MiB });
      assert.deepEqual(ceilings({ imageCeiling: 0, imageByteCeiling: 0 }), { imageCeiling: 0, imageByteCeiling: 0 }, '0 is none');
      for (const bad of [-3, Number.NaN, Infinity]) {
        assert.deepEqual(ceilings({ imageCeiling: bad, imageByteCeiling: bad }), { imageCeiling: 500, imageByteCeiling: 24 * MiB },
          `a ceiling of ${bad} takes the default`);
      }
      assert.deepEqual(ceilings({ imageCeiling: 0.5, imageByteCeiling: 100.7 }), { imageCeiling: 1, imageByteCeiling: 100 },
        'a fraction is floored, to at least 1');
      assert.deepEqual(ceilings({ maxLiveImages: 800, maxLiveImageBytes: 30 * MiB }), { imageCeiling: 500, imageByteCeiling: 24 * MiB },
        "the window's own limits leave the ceilings as they are");
    });
  }
});

describe("the memory strategy's effective config", () => {
  it('reports both ceilings, as the library defaults when the host sets neither, and as the host set them otherwise', async () => {
    const report = async (options: Record<string, unknown>) => {
      const lines: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      try {
        const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: new AutobiographicalStrategy({ logEffectiveConfig: true, ...options }) });
        await manager.close();
      } finally {
        console.error = original;
        rmSync(dir, { recursive: true, force: true });
      }
      const line = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.event === 'config:effective');
      assert.ok(line, JSON.stringify(lines));
      return line as { effective: Record<string, unknown>; provenance: Record<string, unknown> };
    };
    const defaults = await report({});
    assert.equal(defaults.effective.imageCeiling, 500);
    assert.equal(defaults.effective.imageByteCeiling, 24 * MiB);
    assert.equal(defaults.provenance.imageCeiling, 'library-default');
    assert.equal(defaults.provenance.imageByteCeiling, 'library-default');
    const set = await report({ imageCeiling: 40, imageByteCeiling: 0 });
    assert.equal(set.effective.imageCeiling, 40);
    assert.equal(set.effective.imageByteCeiling, 0);
    assert.equal(set.provenance.imageCeiling, 'caller');
  });
});

describe('the window limits resolved within the ceilings', () => {
  const resolve = (configured: Partial<Record<'maxLiveImages' | 'maxLiveImageBytes' | 'imageCeiling' | 'imageByteCeiling', number>>) =>
    resolveLiveImageLimits({ maxLiveImages: 6, maxLiveImageBytes: 20 * MiB, imageCeiling: 500, imageByteCeiling: 24 * MiB, ...configured });

  it('the window is kept within the ceilings, and a ceiling of 0 is none', () => {
    assert.deepEqual(resolve({ maxLiveImages: 0, maxLiveImageBytes: 0 }), {
      target: { images: 500, bytes: 24 * MiB }, ceiling: { images: 500, bytes: 24 * MiB },
    }, 'an unlimited window means up to the ceilings');
    assert.deepEqual(resolve({ maxLiveImages: 800, maxLiveImageBytes: 30 * MiB }).target,
      { images: 500, bytes: 24 * MiB }, 'a window above the ceilings keeps the ceilings');
    assert.deepEqual(resolve({ maxLiveImages: 4, maxLiveImageBytes: MiB, imageCeiling: 10, imageByteCeiling: 2 * MiB }), {
      target: { images: 4, bytes: MiB }, ceiling: { images: 10, bytes: 2 * MiB },
    }, 'a window under configured ceilings keeps its own limits');
    assert.deepEqual(resolve({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0 }), {
      target: { images: 0, bytes: 0 }, ceiling: { images: 0, bytes: 0 },
    }, 'no ceiling leaves an unlimited window unlimited');
    assert.equal(resolve({ maxLiveImages: 4, imageCeiling: 0 }).target.images, 4, 'no ceiling leaves a window as set');
  });

  it("a window limit that isn't a positive finite number is none, and a malformed ceiling takes its default", () => {
    for (const bad of [-3, Number.NaN, Infinity]) {
      assert.equal(resolve({ maxLiveImages: bad }).target.images, 500, `maxLiveImages ${bad} is unlimited, so up to the ceiling`);
      assert.equal(resolve({ maxLiveImageBytes: bad }).target.bytes, 24 * MiB, `maxLiveImageBytes ${bad} is unlimited, so up to the ceiling`);
      assert.equal(resolve({ imageCeiling: bad }).ceiling.images, 500, `imageCeiling ${bad} takes the default`);
      assert.equal(resolve({ imageByteCeiling: bad }).ceiling.bytes, 24 * MiB, `imageByteCeiling ${bad} takes the default`);
    }
    assert.equal(resolve({ maxLiveImages: 0, imageCeiling: -1 }).target.images, 500, 'the window is clamped to the default the malformed ceiling took');
    assert.equal(resolve({ maxLiveImages: Infinity, imageCeiling: 0 }).target.images, 0,
      'an infinite limit with no ceiling is reported as none, 0');
  });

  it('a fractional limit or ceiling is floored, to at least 1', () => {
    assert.equal(resolve({ maxLiveImages: 2.5 }).target.images, 2);
    assert.deepEqual(resolve({ maxLiveImages: 0, imageCeiling: 1.5 }), {
      target: { images: 1, bytes: 20 * MiB }, ceiling: { images: 1, bytes: 24 * MiB },
    });
    assert.equal(resolve({ imageCeiling: 0.5 }).ceiling.images, 1, 'a fraction under 1 is 1, not none');
    assert.equal(resolve({ imageByteCeiling: 100.7 }).ceiling.bytes, 100);
  });
});

describe('the live window within the image ceilings', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: an unlimited count keeps the newest imageCeiling`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 0, imageCeiling: 2 }), 4), '..II');
    });
    it(`${name}: a count above the ceiling keeps the ceiling's worth`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 3, imageCeiling: 2 }), 4), '..II');
    });
    it(`${name}: an unlimited byte budget keeps the newest imageByteCeiling`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 2000 }), 4, 1000), '..II');
    });
    it(`${name}: with no window and no ceilings, every image stays, more than the default window's 6`, async () => {
      assert.equal(await compiled(make({
        maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0,
      }), 8), 'IIIIIIII');
    });
    it(`${name}: the count ceiling binds the images the window counts, nested and generated ones included`, async () => {
      // What the ceilings bind is what the window counts: every image, an
      // image nested in a tool result and a generated image among them.
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: make({ maxLiveImages: 0, imageCeiling: 1 }) });
      try {
        const image = (data: string) =>
          ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } }) as ContentBlock;
        manager.addMessage('Claude', [{ type: 'tool_use', id: 'tu-1', name: 'shot', input: {} }] as ContentBlock[]);
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu-1', content: [image('AAAA'), image('BBBB')] }] as ContentBlock[]);
        for (let i = 1; i <= 2; i++) {
          manager.addMessage('user', [
            { type: 'generated_image', data: 'A'.repeat(4), mimeType: 'image/png' } as ContentBlock,
            { type: 'text', text: `gen-${i}` },
          ]);
        }
        const result = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const blocks = result.messages.flatMap((m) => m.content);
        const nested = blocks
          .filter((b) => b.type === 'tool_result')
          .flatMap((b) => (b as { content: ContentBlock[] }).content)
          .filter((b) => b.type === 'image').length;
        assert.equal(nested, 0, 'the nested images are past a count ceiling of 1');
        const kept = blocks.filter((b) => b.type === 'generated_image').length;
        assert.equal(kept, 1, 'the newest image, a generated one, takes the one slot');
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('the post-strip estimates price an image the ceiling strips as the placeholder', () => {
    const image = (): ContentBlock =>
      ({ type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } }) as ContentBlock;
    const messages = [{ id: 'old', content: [image()] }, { id: 'new', content: [image()] }];
    const store = {
      getAll: () => messages as never[],
      get: (id: string) => (messages.find((m) => m.id === id) as never) ?? null,
      getFrom: (i: number) => messages.slice(i) as never[],
      getTail: (n: number) => messages.slice(-n) as never[],
      length: () => messages.length,
      estimateTokens: (m: { content: ContentBlock[] }) =>
        m.content.reduce((sum, b) => sum + (b.type === 'image' ? 1600 : b.type === 'text' ? Math.ceil(b.text.length / 4) : 0), 0),
      getTokenCalibration: () => 1,
    };
    const estimate = (strategy: AutobiographicalStrategy) =>
      (strategy as unknown as { postStripEstimates(s: typeof store): number[] }).postStripEstimates(store);
    const stripped = [Math.ceil(PLACEHOLDER.length / 4), 1600];
    assert.deepEqual(estimate(memory({ maxLiveImages: 0, imageCeiling: 1 })), stripped, 'by the count ceiling');
    assert.deepEqual(estimate(memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 5 })), stripped,
      'by the byte ceiling: 4 bytes fit, 8 do not');
    // The memo is keyed by the clamped limits, so a changed ceiling prices anew.
    const strategy = memory({ maxLiveImages: 0, imageCeiling: 1 });
    assert.deepEqual(estimate(strategy), stripped);
    (strategy as unknown as { config: { imageCeiling: number } }).config.imageCeiling = 2;
    assert.deepEqual(estimate(strategy), [1600, 1600], 'with a ceiling of 2, both are live');
  });

  it('the hysteresis rule trims against the ceiling when the count is unlimited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
    });
    try {
      const strip = async (n: number) => pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, n);
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      assert.equal(await strip(4), 'IIII');
      manager.addMessage('user', imageMessage('img-5'));
      assert.equal(await strip(5), '...II', 'the ceiling binds: one trim to half of it, not a slide of one');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the hysteresis rule against the byte ceiling', () => {
  it('trims against the byte ceiling when the byte budget is unlimited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }),
    });
    try {
      const strip = async (n: number) => pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, n);
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`, 4));
      assert.equal(await strip(4), 'IIII', 'four 4-byte images fill the 16-byte ceiling');
      manager.addMessage('user', imageMessage('img-5', 4));
      assert.equal(await strip(5), '...II', 'the ceiling binds: one trim to half of it');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the image limits warning', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: says once, at initialize, when a configured window limit is above its ceiling`, async () => {
      const lines: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      try {
        const cases = [
          [{ maxLiveImages: 8, imageCeiling: 4 }, ['maxLiveImages 8 is above imageCeiling 4, so the live window keeps at most 4']],
          [{ maxLiveImageBytes: 3 * MiB, imageByteCeiling: 2 * MiB },
            ['maxLiveImageBytes 3 MiB is above imageByteCeiling 2 MiB, so the live window keeps at most 2 MiB']],
          [{ maxLiveImages: 8, imageCeiling: 4, maxLiveImageBytes: 3 * MiB, imageByteCeiling: 2 * MiB },
            ['maxLiveImages 8 is above imageCeiling 4', 'maxLiveImageBytes 3 MiB is above imageByteCeiling 2 MiB']],
          // A byte figure that isn't a whole number of MiB reads in bytes.
          [{ maxLiveImageBytes: 3 * MiB + 1, imageByteCeiling: 2 * MiB }, [`maxLiveImageBytes ${3 * MiB + 1} bytes is above imageByteCeiling 2 MiB`]],
          [{ imageCeiling: Number.NaN }, ["imageCeiling NaN isn't 0 or a finite number above it, so the default 500 applies"]],
          [{ imageByteCeiling: -1 }, ["imageByteCeiling -1 isn't 0 or a finite number above it, so the default 24 MiB applies"]],
          [{ maxLiveImages: 0, maxLiveImageBytes: 0 }, null],
          [{ maxLiveImages: 4, imageCeiling: 4 }, null],
          // At or above the memory strategy's 12 MiB compression budget, so
          // that budget isn't above the ceiling either.
          [{ maxLiveImageBytes: 16 * MiB, imageByteCeiling: 16 * MiB }, null],
          // A default above a lowered ceiling is named too, marked as the
          // default, and so is a default ceiling under a limit the host set.
          [{ imageByteCeiling: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above imageByteCeiling 2 MiB, so the live window keeps at most 2 MiB']],
          [{ maxLiveImages: 600 }, ['maxLiveImages 600 is above imageCeiling 500 (default), so the live window keeps at most 500']],
          // The default window of 6 comes from the strategy's default config,
          // not from the host, so it's marked too.
          [{ imageCeiling: 4 }, ['maxLiveImages 6 (default) is above imageCeiling 4, so the live window keeps at most 4']],
          // An infinite limit is none, like 0, so nothing is said.
          [{ maxLiveImages: Infinity }, null],
          // A malformed ceiling takes its default, which the later clause marks.
          [{ maxLiveImages: 600, imageCeiling: Number.NaN },
            ["imageCeiling NaN isn't 0 or a finite number above it, so the default 500 applies",
              'maxLiveImages 600 is above imageCeiling 500 (default)']],
          // A byte budget given as null takes its default, and is marked so.
          [{ maxLiveImageBytes: null, imageByteCeiling: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above imageByteCeiling 2 MiB']],
          [{ maxLiveImageBytes: undefined, imageByteCeiling: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above imageByteCeiling 2 MiB']],
          [{ maxLiveImageBytes: 30 * MiB, imageByteCeiling: -1 },
            ["imageByteCeiling -1 isn't 0 or a finite number above it, so the default 24 MiB applies",
              'maxLiveImageBytes 30 MiB is above imageByteCeiling 24 MiB (default)']],
          [{ maxLiveImages: 8, imageCeiling: 0 }, null],
          [{ maxLiveImageBytes: 30 * MiB, imageByteCeiling: 0 }, null],
        ] as const;
        for (const [index, [options, said]] of cases.entries()) {
          lines.length = 0;
          const strategy = make(options);
          // Two stores opened in turn with the one strategy initialize it twice.
          for (const store of ['first', 'second']) {
            const manager = await ContextManager.open({ path: join(dir, `${index}-${store}`), strategy });
            await manager.close();
          }
          const ours = lines.filter((line) => line.includes('above') || line.includes('the default'));
          if (said === null) assert.deepEqual(ours, [], `nothing said for ${JSON.stringify(options)}`);
          else {
            assert.equal(ours.length, 1, `said once, in one line, for ${JSON.stringify(options)}: ${JSON.stringify(ours)}`);
            for (const part of said) assert.ok(ours[0]!.includes(part), `${ours[0]} names ${part}`);
          }
        }
      } finally {
        console.warn = original;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

class Prepared extends AutobiographicalStrategy {
  prepare(request: NormalizedRequest) { return this.prepareCompressionRequest(request); }
  send(request: NormalizedRequest, label: string): NormalizedRequest {
    return (this as unknown as { prepareCompressionCandidate(r: NormalizedRequest, l: string): NormalizedRequest })
      .prepareCompressionCandidate(request, label);
  }
}
function captureErrors<T>(run: () => T): string[] {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  try { run(); return logs; } finally { console.error = original; }
}
const imageBlock = (data: string) => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as ContentBlock;
const request = (...messages: ContentBlock[][]): NormalizedRequest => ({
  messages: messages.map((content) => ({ participant: 'User', content })), config: { model: 'mock', maxTokens: 1000 },
});

describe("the memory strategy's warning names a compression budget above the byte ceiling", () => {
  it('says it once, at initialize', async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    try {
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: memory({ maxCompressionImageBytes: 30 * MiB }) });
      await manager.close();
      const ours = lines.filter((line) => line.includes('maxCompressionImageBytes'));
      assert.equal(ours.length, 1, JSON.stringify(lines));
      assert.ok(ours[0]!.includes('maxCompressionImageBytes 30 MiB is above imageByteCeiling 24 MiB (default), so a compression prompt keeps at most 24 MiB'), ours[0]);
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the memory strategy's warning names its default compression budget under a lowered byte ceiling", () => {
  it('says it, marked as the default, with no clause for a window limit under the ceiling', async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    try {
      const manager = await ContextManager.open({
        path: join(dir, 'store'), strategy: memory({ maxLiveImageBytes: 1 * MiB, imageByteCeiling: 2 * MiB }),
      });
      await manager.close();
      const ours = lines.filter((line) => line.includes('is above'));
      assert.equal(ours.length, 1, JSON.stringify(lines));
      assert.ok(ours[0]!.includes('maxCompressionImageBytes 12 MiB (default) is above imageByteCeiling 2 MiB, so a compression prompt keeps at most 2 MiB'), ours[0]);
      assert.ok(!ours[0]!.includes('maxLiveImageBytes'), ours[0]);
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the line when an image ceiling first strips', () => {
  /** Run `steps` on a fresh store: each adds images (`add`, of `bytes` each,
   *  4 when not given) and compiles. Returns the ceiling lines each step said,
   *  in order, the pattern each compile kept, and the last pattern. Byte
   *  sizes are multiples of 4: the store keeps an
   *  image's data as the bytes its base64 decodes to, so other lengths
   *  come back changed. */
  async function ceilingLines(
    strategy: ContextStrategy,
    steps: Array<number | { add: number; bytes: number }>,
  ): Promise<{ lines: string[]; byStep: string[][]; patterns: string[]; last: string }> {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    let n = 0;
    const byStep: string[][] = [];
    const patterns: string[] = [];
    try {
      for (const step of steps) {
        const { add, bytes } = typeof step === 'number' ? { add: step, bytes: 4 } : step;
        const before = said.length;
        for (let i = 0; i < add; i++) manager.addMessage('user', imageMessage(`img-${++n}`, bytes));
        patterns.push(pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, n));
        byStep.push(said.slice(before).filter((line) => line.includes(CEILING_LINE)));
      }
      return { lines: byStep.flat(), byStep, patterns, last: patterns[patterns.length - 1] ?? '' };
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: says once which ceiling strips, and what it holds`, async () => {
      const cases = [
        [{ maxLiveImages: 0, imageCeiling: 2 }, 'imageCeiling 2 holds maxLiveImages 0 (no limit) to it'],
        [{ maxLiveImages: 5, imageCeiling: 2 }, 'imageCeiling 2 holds maxLiveImages 5 to it'],
        [{ imageCeiling: 2 }, 'imageCeiling 2 holds maxLiveImages 6 (default) to it'],
        [{ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 8 },
          'imageByteCeiling 8 bytes holds maxLiveImageBytes 0 (no limit) to it'],
      ] as const;
      for (const [options, said] of cases) {
        // Three images, then two more: the ceiling strips at the first compile
        // and again at the second, and it's said once, at the first.
        const strategy = make(options);
        const { lines, byStep, patterns } = await ceilingLines(strategy, [3, 2]);
        assert.deepEqual(patterns, ['.II', '...II'], `the ceiling of 2 strips at each compile for ${JSON.stringify(options)}`);
        assert.deepEqual(byStep.map((step) => step.length), [1, 0], `said once, at the first step, for ${JSON.stringify(options)}`);
        assert.ok(lines[0]!.startsWith(`[${strategy.name}] ${said}, so some images are now shown as placeholders`), lines[0]);
        assert.match(lines[0]!, / ns=/, 'through the namespaced route the warning takes');
        // The memory strategy names the option that strips in batches, which
        // is off here; windowed passthrough has none to name.
        assert.equal(lines[0]!.includes('; at the ceiling each new image turns the oldest live ones into placeholders, which rewrites the prompt cache from there, and imageStripHysteresisRatio does that in batches instead'),
          name === 'autobiographical', lines[0]);
      }
    });

    it(`${name}: says nothing when the host's own limit strips, or nothing falls past the ceiling`, async () => {
      for (const [options, steps, kept] of [
        [{ maxLiveImages: 2 }, [3, 2], '...II'],
        [{ maxLiveImages: 2, imageCeiling: 2 }, [3, 2], '...II'],
        [{ maxLiveImages: 0, imageCeiling: 2 }, [1, 1], 'II'],
        // The host's own byte limit strips, under the default byte ceiling.
        [{ maxLiveImageBytes: 8 }, [3, 2], '...II'],
        [{ maxLiveImageBytes: 8, imageByteCeiling: 8 }, [3, 2], '...II'],
      ] as const) {
        const { lines, last } = await ceilingLines(make(options), [...steps]);
        assert.equal(last, kept, `the strip ran for ${JSON.stringify(options)}`);
        assert.deepEqual(lines, [], `nothing said for ${JSON.stringify(options)}`);
      }
    });

    it(`${name}: says it once for each ceiling, when each first strips`, async () => {
      // Four-byte images fill the count ceiling of 3 first, at 12 of the 16
      // bytes; then a 16-byte image fills the byte ceiling, and the next one
      // falls past it.
      const strategy = make({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 3, imageByteCeiling: 16 });
      const { byStep, patterns } = await ceilingLines(strategy, [{ add: 4, bytes: 4 }, { add: 1, bytes: 16 }, { add: 1, bytes: 4 }]);
      // At the third step the byte walk drops the 16-byte image and, being
      // greedy, keeps two older 4-byte ones that still fit (as on main).
      assert.deepEqual(patterns, ['.III', '....I', '..II.I'], 'the count, then the bytes, strip');
      assert.deepEqual(byStep.map((step) => step.length), [1, 1, 0], JSON.stringify(byStep));
      assert.ok(byStep[0]![0]!.includes('imageCeiling 3 holds'), byStep[0]![0]);
      assert.ok(byStep[1]![0]!.includes('imageByteCeiling 16 bytes holds'), byStep[1]![0]);
    });

    it(`${name}: says it when a message's first image passes the byte ceiling and its second fits`, async () => {
      // One message: a 12-byte image, then a 4-byte one, under a byte
      // ceiling of 8. The first is past it on its own and the second fits,
      // so the message holds one image past the ceiling and one it kept.
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: make({ maxLiveImageBytes: 0, imageByteCeiling: 8 }) });
      try {
        manager.addMessage('user', [
          { type: 'image', source: { type: 'base64', data: 'A'.repeat(12), mediaType: 'image/png' } },
          { type: 'image', source: { type: 'base64', data: 'B'.repeat(4), mediaType: 'image/png' } },
          { type: 'text', text: 'pair' },
        ] as ContentBlock[]);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const pair = compiled.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text === 'pair'))!;
        assert.deepEqual(pair.content.filter((b) => b.type === 'image').map((b) => (b as { source: { data: string } }).source.data), ['B'.repeat(4)],
          'the first image is replaced, the second kept');
        const ours = said.filter((line) => line.includes(CEILING_LINE));
        assert.equal(ours.length, 1, JSON.stringify(said));
        assert.ok(ours[0]!.includes('imageByteCeiling 8 bytes holds'), ours[0]);
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${name}: says both lines when both ceilings' limits are over at the same image`, async () => {
      // Three 4-byte images under ceilings of 2 images and 8 bytes: the
      // oldest is past both, so one strip notes both ceilings.
      const { byStep, last } = await ceilingLines(
        make({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 2, imageByteCeiling: 8 }), [3],
      );
      assert.equal(last, '.II');
      assert.equal(byStep[0]!.length, 2, JSON.stringify(byStep));
      assert.ok(byStep[0]!.some((line) => line.includes('imageCeiling 2 holds')), JSON.stringify(byStep));
      assert.ok(byStep[0]!.some((line) => line.includes('imageByteCeiling 8 bytes holds')), JSON.stringify(byStep));
    });

    it(`${name}: says it for a single image bigger than the byte ceiling`, async () => {
      const { byStep, patterns } = await ceilingLines(make({ maxLiveImageBytes: 0, imageByteCeiling: 8 }), [{ add: 1, bytes: 12 }]);
      assert.deepEqual(patterns, ['.'], 'the one image is past the ceiling on its own');
      assert.equal(byStep[0]!.length, 1, JSON.stringify(byStep));
      assert.ok(byStep[0]![0]!.includes('imageByteCeiling 8 bytes holds maxLiveImageBytes 0 (no limit) to it'), byStep[0]![0]);
    });

    it(`${name}: says it when the ceiling's limit is over at an image the render replaces, whether or not the depth limit strips it too`, async () => {
      // Two 8-byte images under a 12-byte ceiling: the older one is past the
      // ceiling. With a depth limit that the older one is also past, the
      // depth strips it with or without the ceiling; the line still says the
      // ceiling holds the setting, since its limit is over there.
      const depth = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 2500 };
      const alone = await ceilingLines(make({ ...depth, imageByteCeiling: 0 }), [{ add: 2, bytes: 8 }]);
      assert.equal(alone.last, '.I', 'the depth limit alone strips the older image');
      assert.deepEqual(alone.lines, [], 'no ceiling, no line');
      const both = await ceilingLines(make({ ...depth, imageByteCeiling: 12 }), [{ add: 2, bytes: 8 }]);
      assert.equal(both.last, '.I', 'the ceiling changes nothing the window keeps');
      assert.equal(both.lines.length, 1, JSON.stringify(both.lines));
      const ceilingOnly = await ceilingLines(make({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 12 }), [{ add: 2, bytes: 8 }]);
      assert.equal(ceilingOnly.last, '.I', 'without the depth limit, the ceiling strips the older image');
      assert.equal(ceilingOnly.lines.length, 1, JSON.stringify(ceilingOnly.lines));
    });

    it(`${name}: says it for the byte ceiling when its limit is over at an image the host's own count limit strips too`, async () => {
      // The older image is past the host's maxLiveImages of 1 and past the
      // 12-byte ceiling: the host's limit strips it whatever the ceiling, and
      // the byte ceiling's limit is over there, so its line is said.
      const { lines, last } = await ceilingLines(make({ maxLiveImages: 1, maxLiveImageBytes: 0, imageByteCeiling: 12 }), [{ add: 2, bytes: 8 }]);
      assert.equal(last, '.I');
      assert.equal(lines.length, 1, JSON.stringify(lines));
      assert.ok(lines[0]!.includes('imageByteCeiling 12 bytes holds'), lines[0]);
    });

    it(`${name}: says nothing from renderAsNewest, whose render a ceiling strips, and leaves the line for the next compile`, async () => {
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: make({ maxLiveImages: 0, imageCeiling: 1 }) });
      const ours = () => said.filter((line) => line.includes(CEILING_LINE));
      try {
        const ids = [1, 2].map((i) => manager.addMessage('user', imageMessage(`img-${i}`)));
        const rendered = manager.renderAsNewest(ids);
        assert.ok(rendered, 'the strategy renders');
        const images = rendered.flatMap((content) => content ?? []).filter((b) => b.type === 'image').length;
        assert.equal(images, 1, 'the ceiling of 1 stripped the older image in the render');
        assert.deepEqual(ours(), [], 'the render says nothing');
        await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        assert.equal(ours().length, 1, JSON.stringify(said));
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${name}: says nothing from a dry compile, and leaves the line for the first compile select returns`, async () => {
      for (const [options, said0] of [
        [{ maxLiveImages: 0, imageCeiling: 2 }, 'imageCeiling 2 holds'],
        [{ maxLiveImageBytes: 0, imageByteCeiling: 8 }, 'imageByteCeiling 8 bytes holds'],
      ] as const) {
        const strategy = make(options);
        const said: string[] = [];
        const original = console.warn;
        console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
        const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
        const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
        const ours = () => said.filter((line) => line.includes(CEILING_LINE));
        try {
          for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
          const dry = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 }, undefined, { dryRun: true });
          assert.equal(pattern(dry.messages, 3), '.II', `the dry compile strips for ${JSON.stringify(options)}`);
          assert.deepEqual(ours(), [], `a dry compile says nothing for ${JSON.stringify(options)}`);
          await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
          assert.equal(ours().length, 1, `the compile returned says it for ${JSON.stringify(options)}`);
          assert.ok(ours()[0]!.includes(said0), ours()[0]);
        } finally {
          console.warn = original;
          await manager.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }

  it('the memory strategy says it when its hysteresis rule trims against a ceiling', async () => {
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 4 holds maxLiveImages 0 (no limit) to it'), lines[0]);
    assert.ok(!lines[0]!.includes('imageStripHysteresisRatio'), `the option is on, so the line doesn't name it: ${lines[0]}`);
  });

  it('the memory strategy says it from its adaptive selection too, and nothing from a preview', async () => {
    const adaptive = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, imageCeiling: 2,
    });
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: adaptive });
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 1 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 3), '..I', 'the preview strips to its own ceiling');
      assert.deepEqual(ours(), [], 'a preview, with its own ceiling, says nothing');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 3), '.II');
      assert.equal(ours().length, 1, JSON.stringify(said));
      assert.ok(ours()[0]!.includes('imageCeiling 2 holds maxLiveImages 0 (no limit) to it'), ours()[0]);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's strip leaves the line only from a render select returns, not a layout rendered to compare against", async () => {
    // Both ways the strip decides: counting what the entries send, and the
    // verdicts of the post-strip estimates (asEstimated), as the adaptive
    // selection and the kv-unified cache check ask for them.
    for (const [options, asEstimated] of [
      [{ maxLiveImages: 0, imageCeiling: 1 }, false],
      [{ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 4 }, false],
      [{ maxLiveImages: 0, imageCeiling: 1 }, true],
      [{ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 4 }, true],
    ] as const) {
    const strategy = memory(options);
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    try {
      for (let i = 1; i <= 2; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const view = (manager as unknown as { messageStore: { createView(): unknown } }).messageStore.createView() as {
        getAll(): Array<{ id: string; participant: string; content: ContentBlock[] }>;
      };
      const entries = () => view.getAll().map((m, index) => ({
        index, sourceMessageId: m.id, sourceRelation: 'copy', participant: m.participant, content: m.content,
      }));
      const strip = strategy as unknown as {
        applyImageStripping(entries: unknown[], store: unknown, opts?: { returned?: boolean; asEstimated?: boolean }): void;
        reportCeilingHits(store: unknown): void;
      };
      const kept = entries();
      strip.applyImageStripping(kept, view, { asEstimated });
      assert.equal(kept.filter((e) => e.content.some((b) => b.type === 'image')).length, 1, 'the strip ran: the ceiling replaced one');
      strip.reportCeilingHits(view);
      assert.deepEqual(ours(), [], `a layout rendered to compare against leaves nothing for ${JSON.stringify(options)}, asEstimated ${asEstimated}`);
      strip.applyImageStripping(entries(), view, { returned: true, asEstimated });
      assert.deepEqual(ours(), [], 'the strip itself says nothing: select reports once it returns the render');
      strip.reportCeilingHits(view);
      assert.equal(ours().length, 1, JSON.stringify(said));
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
    }
  });

  it('the memory strategy says nothing for a select it refuses, and says it for the next one it returns', async () => {
    const adaptive = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, imageCeiling: 2,
    });
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: adaptive });
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      // The newest turn is a call with no result yet: structural repair drops
      // it, and the check after the strip refuses the select.
      manager.addMessage('Claude', [{ type: 'tool_use', id: 'tu-1', name: 'shot', input: {} }] as ContentBlock[]);
      await assert.rejects(manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 }),
        { message: /^Structural repair did not retain the newest turn/ });
      assert.deepEqual(ours(), [], 'a refused select says nothing');
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu-1', content: 'done' }] as ContentBlock[]);
      await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(ours().length, 1, JSON.stringify(said));
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's adaptive selection says it when the ceiling's limit is over at an image it replaces, whether or not the depth limit strips it too", async () => {
    // The adaptive selection's strip applies the post-strip estimates'
    // verdicts, which carry the depth limit's own: two 8-byte images under a
    // 12-byte ceiling, the older one also past a 2,500-token depth limit.
    const adaptive = (options: Record<string, unknown>) => memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 12, ...options,
    });
    const depth = await ceilingLines(adaptive({ imageStripDepthTokens: 2500 }), [{ add: 2, bytes: 8 }]);
    assert.equal(depth.last, '.I', 'the depth limit strips the older image');
    assert.equal(depth.lines.length, 1, JSON.stringify(depth.lines));
    const ceilingOnly = await ceilingLines(adaptive({}), [{ add: 2, bytes: 8 }]);
    assert.equal(ceilingOnly.last, '.I', 'without the depth limit, the ceiling strips the older image');
    assert.equal(ceilingOnly.lines.length, 1, JSON.stringify(ceilingOnly.lines));
  });

  it("the memory strategy says nothing for the rule's set under a preview's own ceiling", async () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const strategy = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, imageCeiling: 10, imageStripHysteresisRatio: 0.5,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    try {
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      // A preview with a ceiling of 2 strips by the rule, for itself only: its
      // trim to half keeps one image when the third comes, and the fourth fits.
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 2 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 4), '..II', "the preview's own set trims to half its ceiling");
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 4), 'IIII', 'the real ceiling of 10 strips nothing');
      assert.deepEqual(ours(), [], "the preview's hypothetical ceiling left no line");
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the memory strategy says nothing for a host with no limits, after a preview with a ceiling of its own', async () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    // Every limit off (the helper sets no depth strip), so the compile's strip has nothing to record.
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({
        hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
        autoTickOnNewMessage: false, maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0,
      }),
    });
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 1 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 3), '..I', 'the preview strips to its own ceiling');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 3), 'III', 'with no limits, the compile keeps every image');
      assert.deepEqual(ours(), [], "the preview's strip isn't the compile's");
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's rule reads its set from the stored messages alone, so a reopened instance says it at its first compile", async () => {
    // The rule keeps no state: a second instance on the same store replays
    // the same set, with the ceiling's trim in it, so it says the line at the
    // first compile it returns, as the first instance did.
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const options = { maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 };
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
    try {
      const first = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
      for (let i = 1; i <= 5; i++) first.addMessage('user', imageMessage(`img-${i}`));
      assert.equal(pattern((await first.compile(budget)).messages, 5), '...II', 'the ceiling trims to half of 4');
      assert.equal(ours().length, 1, JSON.stringify(said));
      await first.close();
      said.length = 0;
      const second = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
      try {
        assert.equal(pattern((await second.compile(budget)).messages, 5), '...II', 'the same set from the same messages');
        assert.equal(ours().length, 1, JSON.stringify(said));
        assert.ok(ours()[0]!.includes('imageCeiling 4 holds'), ours()[0]);
      } finally {
        await second.close();
      }
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [kind, options, named] of [
    ['count', { maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }, 'imageCeiling 4 holds'],
    ['byte', { maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }, 'imageByteCeiling 16 bytes holds'],
  ] as const) {
    it(`the memory strategy's rule reads the set of the branch it compiles, under the ${kind} ceiling`, async () => {
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
      const ours = () => said.filter((line) => line.includes(CEILING_LINE));
      const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
      try {
        manager.addMessage('user', imageMessage('img-1'));
        const main = manager.currentBranch().name;
        const busy = await manager.fork('busy');
        // On the fork, four more images make five, past a count of 4 and past
        // 16 bytes.
        for (let i = 2; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
        await manager.switchBranch(main);
        assert.equal(pattern((await manager.compile(budget)).messages, 1), 'I', 'main holds one image, under its ceiling');
        assert.deepEqual(ours(), [], "main's compile says nothing for the fork's messages");
        await manager.switchBranch(busy);
        assert.equal(pattern((await manager.compile(budget)).messages, 5), '...II', "the fork's set, from its own messages");
        assert.equal(ours().length, 1, JSON.stringify(said));
        assert.ok(ours()[0]!.includes(named), ours()[0]);
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("the memory strategy's rule says nothing when the host's own limit binds", async () => {
    const { lines, last } = await ceilingLines(memory({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }), [5]);
    assert.equal(last, '...II', 'one trim to half the host limit');
    assert.deepEqual(lines, []);
  });

  it("the memory strategy's rule says nothing when the depth limit's trims strip what the ceiling's would", async () => {
    // Three 8-byte images under a 20-byte ceiling and a 2,500-token depth
    // limit, each image message about 1,600 tokens: the depth limit brings
    // a trim on at the second image and again at the third, each stripping
    // the older one, so the bytes never pass the ceiling where a trim begins.
    const depth = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 2500, imageStripHysteresisRatio: 0.5 };
    const alone = await ceilingLines(memory({ ...depth, imageByteCeiling: 0 }), [{ add: 3, bytes: 8 }]);
    const both = await ceilingLines(memory({ ...depth, imageByteCeiling: 20 }), [{ add: 3, bytes: 8 }]);
    assert.equal(alone.last, '..I', 'the depth limit alone strips the two older images');
    assert.equal(both.last, alone.last, 'the ceiling changes nothing the window keeps');
    assert.deepEqual(both.lines, [], JSON.stringify(both.lines));
  });

  /** The memory strategy over `messages`, compiled once: the pattern its
   *  image messages kept, and the ceiling lines it said. */
  async function ruleRun(options: Record<string, unknown>, messages: unknown[][]) {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
    try {
      for (const content of messages) manager.addMessage('user', content as never);
      const images = messages.filter((content) => content.some((b) => (b as { type?: string }).type === 'image')).length;
      const kept = pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, images);
      return { kept, lines: said.filter((line) => line.includes(CEILING_LINE)) };
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the memory strategy's rule says it when the ceiling's limit brings a trim on, though the host's own byte limit or the depth limit is over there too", async () => {
    // A 32-byte image, then three 4-byte ones, under a count ceiling of 3 and
    // a host byte limit of 40, in force: at the fourth image the count passes
    // the ceiling and the bytes (44) pass the host's limit, so one trim has
    // both over. The line is said, since the ceiling's limit brought it on.
    const steps = [{ add: 1, bytes: 32 }, { add: 3, bytes: 4 }];
    const host = await ceilingLines(memory({ maxLiveImages: 0, maxLiveImageBytes: 40, imageCeiling: 3, imageStripHysteresisRatio: 0.5 }), steps);
    assert.ok(host.last.includes('.'), `premise: the trim strips (${host.last})`);
    assert.equal(host.lines.length, 1, JSON.stringify(host.lines));
    assert.ok(host.lines[0]!.includes('imageCeiling 3 holds'), host.lines[0]);

    // A count ceiling of 2 and a 4,000-token depth limit: an image, then a
    // message of two images with about 5,000 tokens of text, where the count
    // passes the ceiling and the first image is past the depth, both at once.
    const image = (data: string): ContentBlock =>
      ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' }, tokenEstimate: 100 }) as ContentBlock;
    const depth = await ruleRun({ maxLiveImages: 0, imageCeiling: 2, imageStripDepthTokens: 4000, imageStripHysteresisRatio: 0.5 }, [
      imageMessage('img-1'),
      [image('B'.repeat(4)), image('C'.repeat(4)), { type: 'text', text: 'img-2' }, { type: 'text', text: 'word '.repeat(2900) }],
    ]);
    assert.ok(depth.kept.startsWith('.'), `premise: the trim strips the first image (${depth.kept})`);
    assert.equal(depth.lines.length, 1, JSON.stringify(depth.lines));
    assert.ok(depth.lines[0]!.includes('imageCeiling 2 holds'), depth.lines[0]);
  });

  it("the memory strategy's rule says it from its own replay, not from the limits' account of the images it strips", async () => {
    // A host byte limit of 40, in force, and a count ceiling of 4. A 36-byte
    // image and an 8-byte one pass the host's limit (44 bytes), and that
    // trim, to 20 bytes, strips the 36-byte image. Three 4-byte images then
    // make four live, 20 bytes, so no trim's start ever has the count over
    // its ceiling. By the limits' own account, newest first, the 36-byte
    // image is past the count ceiling (four kept before it), but the set
    // decides it, and the replay's trims were the host's limit's alone.
    const { lines, patterns } = await ceilingLines(
      memory({ maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 }),
      [{ add: 1, bytes: 36 }, { add: 1, bytes: 8 }, { add: 3, bytes: 4 }],
    );
    assert.deepEqual(patterns, ['I', '.I', '.IIII']);
    assert.deepEqual(lines, [], JSON.stringify(lines));
  });

  it("the memory strategy's rule says nothing for a trim the host's own byte limit brings on, though the ceiling-set count is over its target there", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force. Three
    // 4-byte images, then a 32-byte one: the bytes (44) pass the host's
    // limit, and the count, 4, isn't over its ceiling, though it's over the
    // trim's target of 2. The trim is the host's, so no line.
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 }),
      [3, { add: 1, bytes: 32 }],
    );
    assert.ok(last.includes('.'), `premise: the trim strips (${last})`);
    assert.deepEqual(lines, [], JSON.stringify(lines));
  });

  it("the memory strategy's rule says nothing at a render that replaces no image, though its replay has a ceiling's trim", async () => {
    // Three images under a count ceiling of 2: the third brings a trim on
    // that strips the first two. Then enough text that compression folds the
    // image messages into summaries before the first compile: the replay
    // still has the ceiling's trim, but the render shows no placeholder, so
    // the line waits.
    const membrane = {
      complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: '[mock summary] ' + 'x '.repeat(40) }], usage: { input_tokens: 100, output_tokens: 25 } }),
    } as never;
    const prose = (label: string, tokens: number): ContentBlock[] => [{ type: 'text', text: `${label} ` + 'abcd'.repeat(Math.round(tokens * 2.9 / 4)) }];
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const strategy = memory({
      compressionModel: 'mock', targetChunkTokens: 1500, headWindowTokens: 0, recentWindowTokens: 9000, hierarchical: true,
      maxLiveImages: 0, imageCeiling: 2, imageStripHysteresisRatio: 0.5,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane });
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      for (let k = 0; k < 20; k++) manager.addMessage('user', prose(`t${k}`, 800));
      for (let k = 0; k < 500 && !manager.isReady(); k++) await manager.tick();
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 3), '---', 'premise: every image message is folded into a summary');
      assert.ok(!compiled.messages.some((m) => m.content.some((b) => b.type === 'text' && b.text === PLACEHOLDER)), 'premise: no placeholder');
      assert.deepEqual(said.filter((line) => line.includes(CEILING_LINE)), []);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's rule says both lines when both ceilings' limits bring the same trim on", async () => {
    // Three 4-byte images under ceilings of 2 images and 8 bytes: at the
    // third, the count (3) and the bytes (12) are both over, at one trim.
    const { lines } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 2, imageByteCeiling: 8, imageStripHysteresisRatio: 0.5 }), [3],
    );
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.ok(lines.some((line) => line.includes('imageCeiling 2 holds')), JSON.stringify(lines));
    assert.ok(lines.some((line) => line.includes('imageByteCeiling 8 bytes holds')), JSON.stringify(lines));
  });

  it("the memory strategy's rule keeps a ceiling's trim in its record past a later trim only the host's limit brings on", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force, compiled
    // once, at the end. Five 4-byte images bring the count ceiling's trim
    // on; a 36-byte image then brings a trim on that only the host's byte
    // limit is over at. The replay's record of the first trim stands.
    const { kept, lines } = await ruleRun(
      { maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 },
      [1, 2, 3, 4, 5].map((i) => imageMessage(`img-${i}`)).concat([imageMessage('img-6', 36)]),
    );
    assert.equal(kept, '.....I', 'premise: both trims strip');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 4 holds'), lines[0]);
  });

  it("the memory strategy's line doesn't name imageStripHysteresisRatio under a count ceiling of 1, which leaves it no room", async () => {
    // Under a count ceiling of 1 the rule keeps the newest image at every
    // trim, so it strips at every image as the limits do.
    const { lines } = await ceilingLines(memory({ maxLiveImages: 0, imageCeiling: 1 }), [2]);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 1 holds maxLiveImages 0 (no limit) to it, so some images are now shown as placeholders'), lines[0]);
    assert.ok(!lines[0]!.includes('imageStripHysteresisRatio'), lines[0]);
  });

  it("the memory strategy's line isn't read from a preview's set under ceilings that set no limit", async () => {
    // A preview with maxLiveImages 4 under a count ceiling of 10 limits the
    // count to 4, as the configured 0 under a ceiling of 4 does, but there
    // the host sets the limit, so its trims say nothing for a ceiling.
    // The compile after it, under the configured ceilings, still names the
    // count ceiling its own trim brought on.
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ hierarchical: false, adaptiveResolution: true, maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
    });
    try {
      for (let i = 1; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
      assert.ok(manager.previewContext(budget, { maxLiveImages: 4, imageCeiling: 10 }), 'premise: the strategy previews');
      const compiled = await manager.compile(budget);
      assert.equal(pattern(compiled.messages, 5), '...II');
      const ours = said.filter((line) => line.includes(CEILING_LINE));
      assert.equal(ours.length, 1, JSON.stringify(said));
      assert.ok(ours[0]!.includes('imageCeiling 4 holds'), ours[0]);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("windowed passthrough says nothing for a ceiling's verdict on a message its window drops", async () => {
    // Two image messages under a count ceiling of 1, about 2,000 tokens of
    // text between them, past a 3,000-token budget: the window re-anchors to
    // the newest message, whose image the ceiling keeps. The verdicts are
    // made from the old anchor, where the ceiling strips the older image,
    // which the render no longer holds. With room for both, the same images
    // say the line.
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: windowed({ maxLiveImages: 0, imageCeiling: 1 }) });
    try {
      manager.addMessage('user', imageMessage('img-1'));
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(1200) }]);
      manager.addMessage('user', imageMessage('img-2'));
      const compiled = await manager.compile({ maxTokens: 3000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 2), '-I', 'the window holds the newest message alone');
      assert.equal(compiled.messages.length, 1, 'premise: the text went with the older image');
      assert.deepEqual(said.filter((line) => line.includes(CEILING_LINE)), [], JSON.stringify(said));
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
    const both = await ceilingLines(windowed({ maxLiveImages: 0, imageCeiling: 1 }), [2]);
    assert.equal(both.last, '.I');
    assert.equal(both.lines.length, 1, JSON.stringify(both.lines));
  });

  for (const hierarchical of [true, false]) {
    it(`the memory strategy's rule strips a moved tool result's image as its own message's, and says the line (${hierarchical ? 'hierarchical' : 'adaptive'})`, async () => {
      // Result a holds image A, ahead of image B in its message. Under a count
      // ceiling of 1 the rule strips that message's first image, A, and keeps
      // B. Pairing repair moves result a up beside result b, into another
      // message's entry; A is still its own message's first image.
      const image = (data: string): ContentBlock => ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } }) as ContentBlock;
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({
        path: join(dir, 'store'),
        strategy: memory({ hierarchical, adaptiveResolution: !hierarchical, maxLiveImages: 0, imageCeiling: 1, imageStripHysteresisRatio: 0.5 }),
      });
      try {
        manager.addMessage('Claude', [{ type: 'tool_use', id: 'a', name: 'shot', input: {} }, { type: 'tool_use', id: 'b', name: 'shot', input: {} }] as ContentBlock[]);
        manager.addMessage('User', [{ type: 'tool_result', toolUseId: 'b', content: [{ type: 'text', text: 'result b' }] }] as unknown as ContentBlock[]);
        manager.addMessage('User', [{ type: 'tool_result', toolUseId: 'a', content: [image('AAAA'), { type: 'text', text: 'result a' }] }, image('BBBB')] as unknown as ContentBlock[]);
        manager.addMessage('Claude', [{ type: 'text', text: 'done' }]);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const results = (content: ContentBlock[]) => content.filter((b) => b.type === 'tool_result').map((b) => (b as unknown as { toolUseId: string }).toolUseId).sort().join(',');
        assert.ok(compiled.messages.some((x) => results(x.content) === 'a,b'), 'premise: result a moved beside result b');
        const data = (content: ContentBlock[]): string[] => content.flatMap((b) =>
          b.type === 'image' ? [(b as { source: { data: string } }).source.data]
            : b.type === 'tool_result' && Array.isArray((b as { content?: unknown }).content) ? data((b as unknown as { content: ContentBlock[] }).content) : []);
        assert.deepEqual(compiled.messages.flatMap((x) => data(x.content)), ['BBBB'], 'A stripped, B live');
        const ours = said.filter((line) => line.includes(CEILING_LINE));
        assert.equal(ours.length, 1, JSON.stringify(said));
        assert.ok(ours[0]!.includes('imageCeiling 1 holds'), ours[0]);
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('marks only defaults in force: an explicit undefined maxLiveImages is no limit in the memory strategy, and 6 in windowed passthrough', async () => {
    const auto = await ceilingLines(memory({ maxLiveImages: undefined, imageCeiling: 2 }), [3]);
    assert.equal(auto.lines.length, 1, JSON.stringify(auto.lines));
    assert.ok(auto.lines[0]!.includes('imageCeiling 2 holds maxLiveImages 0 (no limit) to it,'), auto.lines[0]);
    const win = await ceilingLines(windowed({ maxLiveImages: undefined, imageCeiling: 2 }), [3]);
    assert.equal(win.lines.length, 1, JSON.stringify(win.lines));
    assert.ok(win.lines[0]!.includes('imageCeiling 2 holds maxLiveImages 6 (default) to it,'), win.lines[0]);
  });

  it("doesn't mark a value a subclass's enforced layer gives as a default", async () => {
    class Enforced extends AutobiographicalStrategy {
      protected override enforcedConfigLayer() {
        return { source: 'enforced', values: { imageCeiling: 2 } };
      }
    }
    const { lines } = await ceilingLines(
      new Enforced({ headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, maxLiveImages: 0 } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
      [3],
    );
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 2 holds'), lines[0]);
  });

  it('ceilingBoundLine marks a default or malformed ceiling, and gives bytes in MiB', () => {
    const configured = (o: Record<string, number>) =>
      ({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 500, imageByteCeiling: 24 * MiB, ...o });
    assert.equal(ceilingBoundLine('s', 'images', configured({}), new Set(['imageCeiling'])),
      '[s] imageCeiling 500 (default) holds maxLiveImages 0 (no limit) to it, so some images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'images', configured({ imageCeiling: Number.NaN, maxLiveImages: 800 }), new Set()),
      '[s] imageCeiling 500 (default) holds maxLiveImages 800 to it, so some images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB }), new Set()),
      '[s] imageByteCeiling 24 MiB holds maxLiveImageBytes 30 MiB to it, so some images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB + 1 }), new Set(['imageByteCeiling'])),
      `[s] imageByteCeiling 24 MiB (default) holds maxLiveImageBytes ${30 * MiB + 1} bytes to it, so some images are now shown as placeholders`);
  });

  it('the memory strategy says it when its hysteresis rule trims against the byte ceiling', async () => {
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageByteCeiling 16 bytes holds maxLiveImageBytes 0 (no limit) to it'), lines[0]);
  });
});

describe('compression prompts within the image ceilings', () => {
  it('carry at most imageCeiling, the newest messages first', () => {
    const prepared = new Prepared({ imageCeiling: 2 }).prepare(
      request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]),
    );
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imageCountCap, 2);
    assert.equal(prepared.imagesKept, 2);
    assert.deepEqual(prepared.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image']);
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER);
  });

  it('count an image nested in a tool result toward the ceiling', () => {
    const prepared = new Prepared({ imageCeiling: 1 }).prepare(request(
      [imageBlock('AAAA')],
      [{ type: 'tool_result', toolUseId: 't', content: [imageBlock('BBBB')] } as ContentBlock],
    ));
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imagesKept, 1);
    const nested = (prepared.request.messages[1]!.content[0] as { content: ContentBlock[] }).content[0]!;
    assert.equal(nested.type, 'image', 'the newer, nested image takes the one slot');
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER, 'and the older one is replaced');
  });

  it('count a generated image toward the ceiling, so a newer one takes the last slot from an older image', () => {
    const generated = { type: 'generated_image', data: 'BBBB', mimeType: 'image/png' } as ContentBlock;
    const prepared = new Prepared({ imageCeiling: 1 }).prepare(request([imageBlock('AAAA')], [generated]));
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imagesKept, 1);
    assert.equal(prepared.request.messages[1]!.content[0]!.type, 'generated_image', 'the newer, generated image takes the one slot');
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER, 'and the older one is replaced');
  });

  it('keep their byte budget within imageByteCeiling, and the images kept are what it lets through', () => {
    const prepared = new Prepared({ maxCompressionImageBytes: 3 * MiB, imageByteCeiling: 2 * MiB }).prepare(request([]));
    assert.equal(prepared.imageBudgetBytes, 2 * MiB);
    for (const none of [0, Infinity, -3, Number.NaN]) {
      assert.equal(new Prepared({ maxCompressionImageBytes: none, imageByteCeiling: 8 }).prepare(request([])).imageBudgetBytes, 8,
        `a budget of ${none} is none, so up to the byte ceiling`);
    }
    assert.equal(new Prepared({ maxCompressionImageBytes: 8.5, imageByteCeiling: 100 }).prepare(request([])).imageBudgetBytes, 8,
      'a fractional budget is floored');
    const walked = new Prepared({ maxCompressionImageBytes: 12, imageByteCeiling: 8 }).prepare(
      request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]),
    );
    assert.equal(walked.imageBudgetBytes, 8);
    assert.equal(walked.imageReplacements, 1, 'under the clamped 8 bytes, two 4-byte images fit and the oldest does not');
    assert.equal(walked.imageBytesKept, 8);
    assert.deepEqual(walked.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image'], 'the oldest is the one replaced');
    assert.equal(new Prepared({ maxCompressionImageBytes: 0, imageByteCeiling: 2 * MiB }).prepare(request([])).imageBudgetBytes,
      2 * MiB, 'an unlimited budget means up to the ceiling');
    assert.equal(new Prepared().prepare(request([])).imageBudgetBytes, 12 * MiB, 'the default budget is under the default ceiling');
  });

  it('carry at most imageCeiling with no byte budget, and say only the ceiling', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 0, imageByteCeiling: 0, imageCeiling: 1 });
    const input = request([imageBlock('AAAA')], [imageBlock('BBBB')]);
    assert.equal(strategy.prepare(input).imageReplacements, 1);
    assert.deepEqual(captureErrors(() => strategy.send(input, 'no-budget')), [
      '[autobiographical] compression prompt: replaced 1 image(s) with placeholders to stay under the ' +
        '1-image ceiling (kept 1 image(s), 0.0MiB, newest messages first) [no-budget]',
    ]);
  });

  it('with no count ceiling, keep to the byte budget, and the log says only the budget', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 8, imageCeiling: 0 });
    const input = request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]);
    const prepared = strategy.prepare(input);
    assert.equal(prepared.imageCountCap, 0);
    assert.equal(prepared.imageReplacements, 1, 'two 4-byte images fit the 8-byte budget, the oldest does not');
    assert.deepEqual(prepared.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image']);
    const logs = captureErrors(() => strategy.send(input, 'no-count'));
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]!.includes('image ceiling'), logs[0]);
    assert.ok(logs[0]!.includes('inline image budget (kept 2 image(s)'), logs[0]);
  });

  it('with no budget and no ceilings, keep every image, more than the default ceiling of 500', () => {
    const images = Array.from({ length: 501 }, () => [imageBlock('AAAA')]);
    const prepared = new Prepared({ maxCompressionImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0 }).prepare(
      request(...images),
    );
    assert.equal(prepared.imageReplacements, 0);
    assert.equal(prepared.request.messages.filter((m) => m.content[0]!.type === 'image').length, 501, 'all 501 are still images');
    assert.equal(prepared.imagesKept, 501, 'the counts say what was kept');
    assert.equal(prepared.imageBytesKept, 501 * 4);
  });
});
