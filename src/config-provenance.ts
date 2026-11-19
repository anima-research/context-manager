/**
 * Effective-config resolution with per-key provenance.
 *
 * Configuration in this library coalesces through `??`-chains: a library
 * default under a caller-supplied value, with host applications stacking
 * further layers of their own above both. The resulting effective value of any
 * one key is readable only by reconstructing that chain by hand, and the layer
 * it came from is not recoverable at all. This module makes both facts data.
 *
 * It is deliberately schema-agnostic and dependency-free: it knows nothing
 * about strategy config shapes, so hosts can pass their own named layers
 * (environment, profile, per-agent override) through the same resolver the
 * library uses for its own two.
 */

/** One named layer of configuration. Sources are free-form and appear verbatim
 *  in the provenance map, so name them for the operator reading the report:
 *  'library-default', 'caller', 'env', 'agent-override'. */
export interface ConfigLayer {
  source: string;
  values: Record<string, unknown>;
}

/** Resolved configuration plus the source that won each key. Keys of
 *  `provenance` are exactly the keys of `effective`. */
export interface EffectiveConfigReport {
  effective: Record<string, unknown>;
  provenance: Record<string, string>;
}

/**
 * What a layer supplying `undefined` or `null` for a key MEANS. The two live
 * merge idioms in this codebase disagree about it, they are not
 * interchangeable, and picking one silently is how a "pure refactor" changes
 * behavior — so every call states which one it is asking for.
 *
 *  - `'skip-nullish'` — the `??` / `??=` reading, and the general host-facing
 *    one. Every default site in the library (`summaryTargetTokens ?? 2000`,
 *    `this.config.mergeThreshold ??= 6`, ...) is nullish-coalescing, and
 *    `previewContext` states the same rule explicitly for its override merge,
 *    dropping `undefined` and `null` entries BEFORE spreading because a spread
 *    with `foldingStrategy: undefined` erases the live key: "Absence is the
 *    only way to mean 'keep the live value'." So a layer supplying either does
 *    not win a key and does not steal a lower layer's win, and a key no layer
 *    supplies non-nullishly is absent from both maps — never
 *    present-as-undefined.
 *
 *  - `'spread-fidelity'` — the `{ ...defaults, ...caller }` reading. A layer's
 *    OWN keys win, nullish included, exactly as object spread assigns them:
 *    `{ recentWindowTokens: undefined }` erases the default and leaves the key
 *    present-as-undefined. This is what `AutobiographicalStrategy`'s
 *    constructor did before it resolved through this module, and it is what it
 *    still asks for, so that wiring the resolver in changed no effective value
 *    for any caller.
 */
export type ConfigResolutionSemantics = 'skip-nullish' | 'spread-fidelity';

/**
 * Collapse ordered layers (base first) into effective values plus the source
 * that won each key. The LAST layer supplying a value for a key wins, where
 * "supplying" is what `semantics` says it is — see ConfigResolutionSemantics,
 * and state the mode deliberately: the two readings differ for exactly the
 * inputs that are easiest to leave untested.
 *
 * Only own enumerable properties are read, and values are copied by reference:
 * the report shares object/array values with its layers rather than cloning.
 */
export function resolveEffectiveConfig(
  layers: ConfigLayer[],
  semantics: ConfigResolutionSemantics,
): EffectiveConfigReport {
  const effective: Record<string, unknown> = {};
  const provenance: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (semantics === 'skip-nullish' && (value === undefined || value === null)) continue;
      effective[key] = value;
      provenance[key] = layer.source;
    }
  }
  return { effective, provenance };
}
