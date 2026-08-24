/**
 * Effective-config resolution with per-key provenance.
 *
 * Configuration coalesces through `??`-chains — a library default under a
 * caller value, with hosts stacking further layers above both — so an operator
 * asking "what is actually governing this strategy, and who set it" has to
 * reconstruct the chain by hand, and the layer that won is not recoverable at
 * all. `resolveEffectiveConfig` makes both facts data, and the autobiographical
 * strategy now resolves its own config through it.
 *
 * Guarantees under test:
 *  - attribution: the last layer supplying a key wins, and its source is what
 *    the provenance map records;
 *  - a later layer's `undefined` does not steal a lower layer's win, and
 *    neither does `null` — the live `??` / `??=` sites treat the two
 *    identically, and `previewContext` filters both before spreading;
 *  - a key no layer supplies non-nullishly is absent from both maps;
 *  - the null test: the strategy's effective config through the new path is
 *    identical to what the previous spread-then-`??=` constructor produced;
 *  - default silence: with `logEffectiveConfig` unset, construction emits
 *    nothing; with it on, exactly one structured line carrying both maps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AutobiographicalStrategy, resolveEffectiveConfig, DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../src/index.js';
import type { AutobiographicalOptions } from '../src/index.js';

/**
 * The constructor's config resolution EXACTLY as it stood before this change:
 * object spread over the library defaults, then the conditional `??=` repair
 * blocks. The wiring test asserts the new path agrees with this byte for byte.
 */
function resolveConfigTheWayTheConstructorUsedTo(
  config: AutobiographicalOptions,
): Record<string, unknown> {
  const resolved = { ...DEFAULT_AUTOBIOGRAPHICAL_CONFIG, ...config } as Record<string, unknown>;
  resolved.hierarchical ??= true;
  if (resolved.hierarchical) {
    resolved.mergeThreshold ??= 6;
    resolved.summaryTargetTokens ??= 2000;
    resolved.l3BudgetTokens ??= 30000;
    resolved.l2BudgetTokens ??= 30000;
    resolved.l1BudgetTokens ??= 30000;
  }
  if (resolved.adaptiveResolution) {
    resolved.foldingStrategy ??= 'flat-profile';
    resolved.compressionSlackRatio ??= 0.1;
    resolved.speculativeProduction ??= true;
  }
  resolved.compressionCacheMarkers ??= true;
  resolved.compressionCacheTtl ??= '1h';
  return resolved;
}

function readStrategyConfig(strategy: AutobiographicalStrategy): Record<string, unknown> {
  return (strategy as unknown as { config: Record<string, unknown> }).config;
}

function captureStderrLines(body: () => void): string[] {
  const captured: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    captured.push(args.map((a) => String(a)).join(' '));
  };
  try {
    body();
  } finally {
    console.error = original;
  }
  return captured;
}

describe('resolveEffectiveConfig: attribution', () => {
  it('records the last layer supplying each key as its source', () => {
    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: 'base-only', fld2: 11, fld3: false } },
      { source: 'zz-middle', values: { fld2: 22, fld3: true, fld4: 'middle-only' } },
      { source: 'zz-top', values: { fld3: false, fld5: 'top-only' } },
    ]);

    assert.deepStrictEqual(effective, {
      fld1: 'base-only',
      fld2: 22,
      fld3: false,
      fld4: 'middle-only',
      fld5: 'top-only',
    });
    assert.deepStrictEqual(provenance, {
      fld1: 'zz-base',
      fld2: 'zz-middle',
      fld3: 'zz-top',
      fld4: 'zz-middle',
      fld5: 'zz-top',
    });
  });

  it('lets a falsy value win — only nullish means "not supplied"', () => {
    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: 99, fld2: 'set', fld3: true } },
      { source: 'zz-top', values: { fld1: 0, fld2: '', fld3: false } },
    ]);

    assert.deepStrictEqual(effective, { fld1: 0, fld2: '', fld3: false });
    assert.deepStrictEqual(provenance, { fld1: 'zz-top', fld2: 'zz-top', fld3: 'zz-top' });
  });

  it('does not let a later undefined or null steal a lower layer\'s win', () => {
    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: 'kept', fld2: 'kept', fld3: 'kept' } },
      { source: 'zz-top', values: { fld1: undefined, fld2: null, fld3: 'taken' } },
    ]);

    assert.deepStrictEqual(effective, { fld1: 'kept', fld2: 'kept', fld3: 'taken' });
    assert.deepStrictEqual(provenance, { fld1: 'zz-base', fld2: 'zz-base', fld3: 'zz-top' });
  });

  it('omits a key no layer supplies non-nullishly, rather than carrying it as undefined', () => {
    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: undefined, fld2: null } },
      { source: 'zz-top', values: { fld1: null } },
    ]);

    assert.deepStrictEqual(effective, {});
    assert.deepStrictEqual(provenance, {});
    assert.strictEqual('fld1' in effective, false);
  });

  it('resolves no layers, and empty layers, to empty maps', () => {
    assert.deepStrictEqual(resolveEffectiveConfig([]), { effective: {}, provenance: {} });
    assert.deepStrictEqual(resolveEffectiveConfig([{ source: 'zz-base', values: {} }]), {
      effective: {},
      provenance: {},
    });
  });
});

describe('AutobiographicalStrategy: config wiring is value-identical', () => {
  const fixtures: Array<{ label: string; config: AutobiographicalOptions }> = [
    { label: 'no caller config at all', config: {} },
    {
      label: 'a caller overriding defaults and adding non-default keys',
      config: { targetChunkTokens: 1234, summaryParticipant: 'zz-participant', mergeThreshold: 9 },
    },
    { label: 'hierarchical explicitly off', config: { hierarchical: false } },
    { label: 'adaptive resolution on', config: { adaptiveResolution: true } },
    {
      label: 'adaptive resolution on with the gated keys already set',
      config: { adaptiveResolution: true, foldingStrategy: 'kv-stable', compressionSlackRatio: 0.25 },
    },
    {
      label: 'a caller overriding the unconditional compression-cache defaults',
      config: { compressionCacheMarkers: false, compressionCacheTtl: '5m' },
    },
  ];

  for (const { label, config } of fixtures) {
    it(`resolves the same effective values as the previous constructor: ${label}`, () => {
      const strategy = new AutobiographicalStrategy(config);
      assert.deepStrictEqual(
        readStrategyConfig(strategy),
        resolveConfigTheWayTheConstructorUsedTo(config),
      );
    });
  }

  it('attributes every effective key to the layer that supplied it', () => {
    const strategy = new AutobiographicalStrategy({
      targetChunkTokens: 1234,
      summaryParticipant: 'zz-participant',
    });
    const effective = readStrategyConfig(strategy);

    assert.strictEqual(effective.targetChunkTokens, 1234);
    assert.strictEqual(strategy.configProvenance.targetChunkTokens, 'caller');
    assert.strictEqual(strategy.configProvenance.summaryParticipant, 'caller');
    // Untouched by the caller, and supplied by two different default sites:
    // the exported DEFAULT_AUTOBIOGRAPHICAL_CONFIG and the constructor's own
    // conditional blocks. Both are the library speaking.
    assert.strictEqual(effective.recentWindowTokens, DEFAULT_AUTOBIOGRAPHICAL_CONFIG.recentWindowTokens);
    assert.strictEqual(strategy.configProvenance.recentWindowTokens, 'library-default');
    assert.strictEqual(effective.mergeThreshold, 6);
    assert.strictEqual(strategy.configProvenance.mergeThreshold, 'library-default');

    // Total over the effective config: every key legible, none unattributed.
    assert.deepStrictEqual(
      Object.keys(strategy.configProvenance).sort(),
      Object.keys(effective).sort(),
    );
  });

  it('treats a caller\'s explicit undefined as "not supplied", as previewContext already does', () => {
    // The one input class where the layered resolver differs from the raw
    // spread it replaces: the spread erased the default, leaving the key
    // present-as-undefined for every read without its own inline fallback.
    const strategy = new AutobiographicalStrategy({ recentWindowTokens: undefined });

    assert.strictEqual(
      readStrategyConfig(strategy).recentWindowTokens,
      DEFAULT_AUTOBIOGRAPHICAL_CONFIG.recentWindowTokens,
    );
    assert.strictEqual(strategy.configProvenance.recentWindowTokens, 'library-default');
  });
});

describe('AutobiographicalStrategy: effective-config report', () => {
  it('emits nothing at construction by default', () => {
    const emitted = captureStderrLines(() => {
      new AutobiographicalStrategy();
      new AutobiographicalStrategy({ targetChunkTokens: 1234 });
      new AutobiographicalStrategy({ logEffectiveConfig: false });
    });

    assert.deepStrictEqual(emitted, []);
  });

  it('emits exactly one structured line carrying both maps when asked', () => {
    const emitted = captureStderrLines(() => {
      new AutobiographicalStrategy({ logEffectiveConfig: true, targetChunkTokens: 1234 });
    });

    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0]!.includes('\n'), false);

    const report = JSON.parse(emitted[0]!) as {
      event: string;
      strategy: string;
      effective: Record<string, unknown>;
      provenance: Record<string, string>;
    };
    assert.strictEqual(report.event, 'config:effective');
    assert.strictEqual(report.strategy, 'autobiographical');
    assert.strictEqual(report.effective.targetChunkTokens, 1234);
    assert.strictEqual(report.provenance.targetChunkTokens, 'caller');
    assert.strictEqual(report.provenance.recentWindowTokens, 'library-default');
    assert.deepStrictEqual(
      Object.keys(report.provenance).sort(),
      Object.keys(report.effective).sort(),
    );
  });
});
