/**
 * What a host can observe of a context manager's work as it happens: each
 * compile, each refusal context-manager itself makes of compression, and each
 * calibration sample. A host passes one `ContextObserver` to
 * `ContextManager.open` (`observer`), and the manager hands it to its strategy
 * in `StrategyContext`.
 *
 * The records are facts on context-manager's own terms. What a host keeps or
 * sends, and in what shape, is the host's to decide: a record can hold text
 * from the store, such as a refusal's message, which names pins.
 */

import type { RenderStats } from './types/strategy.js';

/**
 * The thrown errors that are a compile's refusals, by `Error.name`: a
 * designed answer that the compile can't fit or can't cover its messages, as
 * opposed to a defect. The name survives two copies of context-manager in one
 * process, where `instanceof` doesn't.
 */
export const COMPILE_REFUSALS = ['OverBudgetError', 'UncoveredDropError'] as const;

/** A name of {@link COMPILE_REFUSALS}. */
export type CompileRefusal = typeof COMPILE_REFUSALS[number];

/**
 * Context-manager's own refusals of compression, from a closed list. A
 * provider's refusal or error on a compression call is the provider's
 * decision, not one of these:
 * - `'admission-rejected'`: the request didn't fit `compressionContextBudgetTokens`,
 *   so no call was made.
 * - `'topology-violation'`: a merge's sources don't make a group it can
 *   mint over (fewer than two, not one level below its target, or not
 *   adjacent in store order), so no call was made and the group went into the
 *   merge quarantine.
 * - `'empty'`: the response held no text to keep, such as text that was a
 *   literal `<thinking>` preamble alone.
 * - `'incomplete'`: the response stopped other than at `end_turn` and wasn't
 *   a refusal (a `max_tokens` cut, a tool call, a stop sequence), so its text
 *   isn't kept.
 * - `'malformed'`: the response, or a block in it, isn't the shape a response
 *   has.
 * - `'chunk-call-cap'`: the split rung (`compressionSplitFallback`) reached
 *   its cap on calls in one attempt at a chunk
 *   (`compressionSplitMaxCallsPerChunk`) before it could finish, so it ended
 *   before another call.
 * - `'window-call-cap'`: the split rung's attempt alone used every call its
 *   ten-minute window allows (`compressionSplitMaxCallsPer10Min`), so it ended
 *   before another call.
 * - `'overlap-guard'`: a chunk's messages are partly covered by an L1 that
 *   already exists, so the strategy refuses to compress it rather than mint
 *   a duplicate memory. In the autobiographical strategy's own chunking only
 *   damaged bookkeeping or store surgery leaves that; `KnowledgeStrategy`
 *   leaves it when a summary ends at a tool call whose result comes after
 *   it. A chunk with a record isn't queued again while it's refused, and
 *   one without is refused again each time it's queued. Either way it's
 *   reported once per chunk (its record id, or else its messages), as the
 *   guard's log line is, until the strategy loads its state again: an open,
 *   a branch switch, a branch's state set up again, or taking up what
 *   another instance sharing the store wrote.
 *
 * The rest are reported once per decision. A verdict on an answer the L1 ladder
 * keeps in its saved progress isn't decided again when the ladder resumes,
 * so it isn't reported again; an admission rejection makes no call, so
 * progress keeps none, and each ladder run that reaches it decides and
 * reports it anew. In the split rung, each piece's empty or incomplete answer
 * is reported as it comes, a cap's trip when the rung ends, and a malformed
 * piece ends the rung as `'malformed'`.
 */
export const COMPRESSION_REFUSALS = [
  'admission-rejected',
  'topology-violation',
  'empty',
  'incomplete',
  'malformed',
  'chunk-call-cap',
  'window-call-cap',
  'overlap-guard',
] as const;

/** A reason of {@link COMPRESSION_REFUSALS}. */
export type CompressionRefusal = typeof COMPRESSION_REFUSALS[number];

/**
 * What a calibration sample did, from a closed list:
 * - `'out-of-band'`: rejected, since neither its ratio nor the multiplier it
 *   implies is within the sanity band; the multiplier stays.
 * - `'held'`: within the dead band of the multiplier in force, which stays.
 * - `'confirmed'`: within the dead band of a provisional multiplier, which
 *   stays and is no longer provisional.
 * - `'replaced'`: a provisional multiplier replaced by what the sample
 *   implies, within the clamp.
 * - `'stepped'`: the multiplier moved a step toward what the sample implies,
 *   within the clamp.
 */
export const CALIBRATION_SAMPLE_OUTCOMES = ['out-of-band', 'held', 'confirmed', 'replaced', 'stepped'] as const;

/** An outcome of {@link CALIBRATION_SAMPLE_OUTCOMES}. */
export type CalibrationSampleOutcome = typeof CALIBRATION_SAMPLE_OUTCOMES[number];

/** One `ContextManager.compile()`, refused or failed ones included. */
export interface CompileRecord {
  /** The strategy's `name`. */
  strategy: string;
  /** Whether it was a dry compile (`SelectOptions.dryRun`). */
  dryRun: boolean;
  /** When it started, on the wall clock (`Date.now()`, ms since epoch). */
  startedAt: number;
  /** How long the whole `compile()` took, on the monotonic clock, in ms. */
  durationMs: number;
  /**
   * `'compiled'`; `'refused'`, when it threw one of {@link COMPILE_REFUSALS};
   * or `'failed'`, when it threw anything else.
   */
  outcome: 'compiled' | 'refused' | 'failed';
  /**
   * What a refused or failed compile threw, as the caller receives it, such as
   * an `OverBudgetError` with its `stageId`, `budget`, `actual`, `clearedBy` and
   * `diagnostics`. Treat it as read-only.
   */
  error?: unknown;
  /**
   * A compiled compile's render stats, the object its `CompileResult.renderStats`
   * holds (calibration in force, solver, the view's message count), when its
   * strategy records them. Treat them as read-only.
   */
  renderStats?: RenderStats;
}

/** One refusal context-manager made of compression (see {@link COMPRESSION_REFUSALS}). */
export interface CompressionRefusalRecord {
  reason: CompressionRefusal;
}

/** One calibration sample: the provider report a compile's estimate is compared with. */
export interface CalibrationSampleRecord {
  outcome: CalibrationSampleOutcome;
  /** The provider's input total over the compile's estimate. */
  ratio: number;
  /** The multiplier in force after the sample. */
  multiplier: number;
}

/**
 * Called synchronously as each fact happens, each callback optional. What
 * it throws, or a promise it returns that rejects, never reaches the work it
 * observes: the manager logs a callback's first failure through its
 * diagnostics, and drops the rest. Outside that is a returned promise no
 * JavaScript can give a handler, such as one whose `constructor` or species
 * can't be used, or a proxy around one: its rejection goes unhandled, which
 * ends a Node process by default. A record's error and render stats are the
 * objects the caller gets, so an observer treats them as read-only.
 */
export interface ContextObserver {
  compile?(record: CompileRecord): void;
  compression?(record: CompressionRefusalRecord): void;
  calibration?(record: CalibrationSampleRecord): void;
}

/**
 * `observer` with each callback it has wrapped, so that nothing it throws or
 * rejects reaches the caller, but for a returned promise no JavaScript can
 * give a handler (see {@link ContextObserver}). `failed` hears of a
 * callback's first throw or rejection, once per callback, so a broken
 * observer shows without a line per record. Each callback is read once, here, and that function is the one
 * called, so replacing or removing it later changes nothing; one that can't
 * even be read is treated as absent, and told of the same way.
 */
export function isolateObserver(
  observer: ContextObserver,
  failed: (callback: keyof ContextObserver, error: unknown) => void,
): ContextObserver {
  const isolated: ContextObserver = {};
  const told = new Set<keyof ContextObserver>();
  const fail = (callback: keyof ContextObserver, error: unknown): void => {
    if (told.has(callback)) return;
    told.add(callback);
    try {
      failed(callback, error);
    } catch {
      // Telling of a failure can't end the work either.
    }
  };
  for (const name of ['compile', 'compression', 'calibration'] as const) {
    let callback: unknown;
    try {
      callback = observer[name];
    } catch (error) {
      fail(name, error);
    }
    if (typeof callback !== 'function') continue;
    const method = callback;
    isolated[name] = (record: never) => {
      try {
        const returned: unknown = Reflect.apply(method, observer, [record]);
        if ((typeof returned === 'object' && returned !== null) || typeof returned === 'function') {
          // The fulfilment handler returns nothing, so nothing returned is
          // read again.
          const handlers = [() => undefined, (error: unknown) => fail(name, error)];
          let handled = false;
          try {
            // A native promise, a subclass's included, takes the handler on
            // itself through the intrinsic `then`, so a `then` of its own
            // can't skip it. The intrinsic `then` refuses anything else
            // before reading it.
            Reflect.apply(Promise.prototype.then, returned, handlers);
            handled = true;
          } catch {
            // Not a native promise, or one whose constructor or species
            // can't be used; the adoption below tells of the latter.
          }
          if (!handled) {
            // Anything else may be a thenable. Promise.resolve reads its
            // `then` at once and calls it in a job of its own, so a `then`
            // getter that throws, or a `then` that throws before it settles,
            // rejects the promise handled here. (A promise no JavaScript can
            // give a handler, such as one whose constructor or species can't
            // be used, or a proxy around one, keeps its own rejection
            // unhandled. What it throws is told where the adoption or the
            // catch below meets it, if either does: one whose species can't
            // be used and whose own `then` is undefined is adopted as a plain
            // value, and nothing is told.)
            Reflect.apply(Promise.prototype.then, Promise.resolve(returned), handlers);
          }
        }
      } catch (error) {
        // An observer can't end a compile, a compression or a sample.
        fail(name, error);
      }
    };
  }
  return isolated;
}

/**
 * Whether `error` is one of {@link COMPILE_REFUSALS}. A value whose `name`
 * can't be read, such as a revoked proxy, isn't, and reading it never throws,
 * so the caller still gets what the compile threw.
 */
export function isCompileRefusal(error: unknown): boolean {
  try {
    const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
    return typeof name === 'string' && (COMPILE_REFUSALS as readonly string[]).includes(name);
  } catch {
    return false;
  }
}
