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
 *  - the two semantics are different functions of the same layers, and both are
 *    pinned: 'skip-nullish' treats a later `undefined`/`null` as "not supplied",
 *    while 'spread-fidelity' lets a layer's own keys win exactly as object
 *    spread assigns them;
 *  - the null test, DIRECT over divergent inputs: the strategies' effective
 *    config through the layered path is identical to what the previous
 *    spread-then-`??=` constructors produced, for callers that supply explicit
 *    `undefined` and explicit `null` as well as ordinary values;
 *  - a subclass's forced values are attributed to the subclass, not to the
 *    caller, and the report names the strategy the instance actually is;
 *  - default silence: with `logEffectiveConfig` unset, nothing is emitted; with
 *    it on, exactly one structured line carrying both maps.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import {
  ContextManager,
  AutobiographicalStrategy,
  KnowledgeStrategy,
  resolveEffectiveConfig,
  DEFAULT_AUTOBIOGRAPHICAL_CONFIG,
} from '../src/index.js';
import type { AutobiographicalOptions, KnowledgeOptions } from '../src/index.js';

const TEST_STORE_PATH = './test-config-provenance';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

/**
 * AutobiographicalStrategy's config resolution EXACTLY as it stood before this
 * change: object spread over the library defaults, then the conditional `??=`
 * repair blocks. The wiring tests assert the new path agrees with this key for
 * key, INCLUDING for callers whose keys are explicitly undefined or null —
 * which the spread kept and a nullish-skipping resolver would not.
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

/** KnowledgeStrategy's, likewise: it forced hierarchical mode by spreading
 *  `hierarchical: true` over the caller's own options before calling super. */
function resolveKnowledgeConfigTheWayTheConstructorUsedTo(
  config: KnowledgeOptions,
): Record<string, unknown> {
  return resolveConfigTheWayTheConstructorUsedTo({ ...config, hierarchical: true });
}

function readStrategyConfig(strategy: AutobiographicalStrategy): Record<string, unknown> {
  return (strategy as unknown as { config: Record<string, unknown> }).config;
}

/** Every key the library defaults carry, supplied by the caller as one nullish
 *  value. The exhaustive form of the divergent-input fixture: whatever the old
 *  spread did with an erased default, it did for all of these. */
function everyDefaultKeySuppliedAs(value: undefined | null): AutobiographicalOptions {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_AUTOBIOGRAPHICAL_CONFIG)) config[key] = value;
  return config as AutobiographicalOptions;
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

async function captureStderrLinesAsync(body: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    captured.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return captured;
}

interface EffectiveConfigLogLine {
  event: string;
  strategy: string;
  effective: Record<string, unknown>;
  provenance: Record<string, string>;
}

/** The library talks to stderr for several reasons; this test is about one of
 *  them, so select by event rather than asserting on everything emitted. */
function effectiveConfigLines(emitted: string[]): EffectiveConfigLogLine[] {
  const lines: EffectiveConfigLogLine[] = [];
  for (const line of emitted) {
    if (!line.startsWith('{')) continue;
    const parsed = JSON.parse(line) as EffectiveConfigLogLine;
    if (parsed.event === 'config:effective') lines.push(parsed);
  }
  return lines;
}

/** Construct, open a manager around it (which initializes the strategy), and
 *  return everything that reached stderr plus the effective-config lines in it. */
async function reportFromInitializing(
  strategy: AutobiographicalStrategy,
): Promise<{ emitted: string[]; reports: EffectiveConfigLogLine[] }> {
  cleanup();
  const emitted = await captureStderrLinesAsync(async () => {
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    manager.close();
  });
  cleanup();
  return { emitted, reports: effectiveConfigLines(emitted) };
}

describe('resolveEffectiveConfig: attribution', () => {
  it('records the last layer supplying each key as its source', () => {
    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: 'base-only', fld2: 11, fld3: false } },
      { source: 'zz-middle', values: { fld2: 22, fld3: true, fld4: 'middle-only' } },
      { source: 'zz-top', values: { fld3: false, fld5: 'top-only' } },
    ], 'skip-nullish');

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

  it('lets a falsy value win under either semantics — only nullish is special', () => {
    const layers = [
      { source: 'zz-base', values: { fld1: 99, fld2: 'set', fld3: true } },
      { source: 'zz-top', values: { fld1: 0, fld2: '', fld3: false } },
    ];

    for (const semantics of ['skip-nullish', 'spread-fidelity'] as const) {
      const { effective, provenance } = resolveEffectiveConfig(layers, semantics);
      assert.deepStrictEqual(effective, { fld1: 0, fld2: '', fld3: false });
      assert.deepStrictEqual(provenance, { fld1: 'zz-top', fld2: 'zz-top', fld3: 'zz-top' });
    }
  });

  it('resolves no layers, and empty layers, to empty maps', () => {
    assert.deepStrictEqual(resolveEffectiveConfig([], 'skip-nullish'), { effective: {}, provenance: {} });
    assert.deepStrictEqual(resolveEffectiveConfig([{ source: 'zz-base', values: {} }], 'spread-fidelity'), {
      effective: {},
      provenance: {},
    });
  });
});

describe('resolveEffectiveConfig: skip-nullish semantics', () => {
  it('does not let a later undefined or null steal a lower layer\'s win', () => {
    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: 'kept', fld2: 'kept', fld3: 'kept' } },
      { source: 'zz-top', values: { fld1: undefined, fld2: null, fld3: 'taken' } },
    ], 'skip-nullish');

    assert.deepStrictEqual(effective, { fld1: 'kept', fld2: 'kept', fld3: 'taken' });
    assert.deepStrictEqual(provenance, { fld1: 'zz-base', fld2: 'zz-base', fld3: 'zz-top' });
  });

  it('omits a key no layer supplies non-nullishly, rather than carrying it as undefined', () => {
    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: undefined, fld2: null } },
      { source: 'zz-top', values: { fld1: null } },
    ], 'skip-nullish');

    assert.deepStrictEqual(effective, {});
    assert.deepStrictEqual(provenance, {});
    assert.strictEqual('fld1' in effective, false);
  });
});

describe('resolveEffectiveConfig: spread-fidelity semantics', () => {
  it('resolves exactly as object spread assigns, undefined and null included', () => {
    const zzBase = { fld1: 'erased', fld2: 'erased', fld3: 'kept', fld4: 'taken' };
    const zzTop = { fld1: undefined, fld2: null, fld4: 'winner', fld5: 'top-only' };

    const { effective, provenance } = resolveEffectiveConfig([
      { source: 'zz-base', values: zzBase },
      { source: 'zz-top', values: zzTop },
    ], 'spread-fidelity');

    assert.deepStrictEqual(effective, { ...zzBase, ...zzTop });
    assert.deepStrictEqual(provenance, {
      fld1: 'zz-top',
      fld2: 'zz-top',
      fld3: 'zz-base',
      fld4: 'zz-top',
      fld5: 'zz-top',
    });
  });

  it('keeps a key present-as-undefined, which is how a spread erases a default', () => {
    const { effective } = resolveEffectiveConfig([
      { source: 'zz-base', values: { fld1: 'erased' } },
      { source: 'zz-top', values: { fld1: undefined } },
    ], 'spread-fidelity');

    assert.strictEqual('fld1' in effective, true);
    assert.strictEqual(effective.fld1, undefined);
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
    // Divergent inputs: every fixture below carries a caller key the caller
    // supplied NULLISHLY. The old spread let those keys win and erase the
    // default; a nullish-skipping resolve does not, which is the entire
    // behavioral difference between the two readings.
    {
      label: 'a caller supplying explicit undefined for a defaulted key',
      config: { recentWindowTokens: undefined },
    },
    {
      label: 'a caller supplying explicit null for a defaulted key',
      config: { targetChunkTokens: null as unknown as number },
    },
    {
      label: 'a caller supplying explicit undefined for a key with no library default',
      config: { productionBudgetTokens: undefined },
    },
    {
      label: 'a caller supplying explicit undefined for a `??=`-repaired key, with its gate off',
      config: { hierarchical: false, mergeThreshold: undefined },
    },
    {
      label: 'a caller supplying explicit undefined for a `??=`-repaired key, with its gate on',
      config: { hierarchical: true, mergeThreshold: undefined, compressionCacheTtl: undefined },
    },
    {
      label: 'a caller supplying explicit null for an adaptive-gated key',
      config: { adaptiveResolution: true, foldingStrategy: null as unknown as undefined },
    },
    {
      label: 'a caller supplying explicit undefined for EVERY defaulted key',
      config: everyDefaultKeySuppliedAs(undefined),
    },
    {
      label: 'a caller supplying explicit null for EVERY defaulted key',
      config: everyDefaultKeySuppliedAs(null),
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

  it('keeps a caller\'s explicit undefined, as the spread it replaced did', () => {
    // The input class where the two readings differ. The strategy asks for
    // spread fidelity, so the caller's own key wins and the default is erased —
    // leaving the key present-as-undefined for every read without its own
    // inline fallback, exactly as before this wiring existed.
    const strategy = new AutobiographicalStrategy({ recentWindowTokens: undefined });
    const effective = readStrategyConfig(strategy);

    assert.strictEqual('recentWindowTokens' in effective, true);
    assert.strictEqual(effective.recentWindowTokens, undefined);
    assert.strictEqual(strategy.configProvenance.recentWindowTokens, 'caller');
  });
});

describe('KnowledgeStrategy: forced config is attributed to the subclass', () => {
  const fixtures: Array<{ label: string; config: KnowledgeOptions }> = [
    { label: 'no caller config at all', config: {} },
    {
      label: 'a caller overriding defaults',
      config: { targetChunkTokens: 1234, summaryParticipant: 'zz-participant' },
    },
    { label: 'a caller trying to switch hierarchical off', config: { hierarchical: false } },
    {
      label: 'a caller supplying explicit undefined for a defaulted key',
      config: { recentWindowTokens: undefined },
    },
    {
      label: 'a caller supplying explicit null for EVERY defaulted key',
      config: everyDefaultKeySuppliedAs(null) as KnowledgeOptions,
    },
  ];

  for (const { label, config } of fixtures) {
    it(`resolves the same effective values as the previous constructor: ${label}`, () => {
      const strategy = new KnowledgeStrategy(config);
      assert.deepStrictEqual(
        readStrategyConfig(strategy),
        resolveKnowledgeConfigTheWayTheConstructorUsedTo(config),
      );
    });
  }

  it('attributes forced hierarchical to the enforcing layer, not to the caller', () => {
    const strategy = new KnowledgeStrategy({ targetChunkTokens: 1234 });

    assert.strictEqual(readStrategyConfig(strategy).hierarchical, true);
    assert.strictEqual(strategy.configProvenance.hierarchical, 'knowledge-enforced');
    // Genuine caller keys are still the caller's, and the library's are still
    // the library's: the enforced layer carries only what it forces.
    assert.strictEqual(strategy.configProvenance.targetChunkTokens, 'caller');
    assert.strictEqual(strategy.configProvenance.recentWindowTokens, 'library-default');
    assert.strictEqual(
      Object.values(strategy.configProvenance).filter((s) => s === 'knowledge-enforced').length,
      1,
    );
  });

  it('attributes hierarchical to the enforcing layer even when the caller asked for it', () => {
    const strategy = new KnowledgeStrategy({ hierarchical: true });

    assert.strictEqual(strategy.configProvenance.hierarchical, 'knowledge-enforced');
  });

  it('leaves the base strategy with no enforced keys at all', () => {
    const strategy = new AutobiographicalStrategy({ hierarchical: true });

    assert.strictEqual(strategy.configProvenance.hierarchical, 'caller');
    assert.deepStrictEqual(
      Object.values(strategy.configProvenance).filter((s) => s !== 'caller' && s !== 'library-default'),
      [],
    );
  });
});

describe('AutobiographicalStrategy: effective-config report', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('emits nothing at all by default', async () => {
    const constructed = captureStderrLines(() => {
      new AutobiographicalStrategy();
      new AutobiographicalStrategy({ targetChunkTokens: 1234 });
      new AutobiographicalStrategy({ logEffectiveConfig: false });
      new KnowledgeStrategy();
    });
    assert.deepStrictEqual(constructed, []);

    const initialized = await reportFromInitializing(new AutobiographicalStrategy({ targetChunkTokens: 1234 }));
    assert.deepStrictEqual(initialized.reports, []);
  });

  it('emits exactly one structured line carrying both maps when asked', async () => {
    const { emitted, reports } = await reportFromInitializing(
      new AutobiographicalStrategy({ logEffectiveConfig: true, targetChunkTokens: 1234 }),
    );

    assert.strictEqual(reports.length, 1);
    assert.strictEqual(emitted.filter((line) => line.includes('\n')).length, 0);
    const report = reports[0]!;
    assert.strictEqual(report.strategy, 'autobiographical');
    assert.strictEqual(report.effective.targetChunkTokens, 1234);
    assert.strictEqual(report.provenance.targetChunkTokens, 'caller');
    assert.strictEqual(report.provenance.recentWindowTokens, 'library-default');
    assert.deepStrictEqual(
      Object.keys(report.provenance).sort(),
      Object.keys(report.effective).sort(),
    );
  });

  it('names the strategy the instance actually is, not the class that resolved the config', async () => {
    const { reports } = await reportFromInitializing(
      new KnowledgeStrategy({ logEffectiveConfig: true, targetChunkTokens: 1234 }),
    );

    assert.strictEqual(reports.length, 1);
    const report = reports[0]!;
    assert.strictEqual(report.strategy, 'knowledge');
    assert.strictEqual(report.provenance.hierarchical, 'knowledge-enforced');
    assert.strictEqual(report.provenance.targetChunkTokens, 'caller');
  });
});
