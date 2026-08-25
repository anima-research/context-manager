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
 * Collapse ordered layers (base first) into effective values plus the source
 * that won each key. The LAST layer supplying a value for a key wins.
 *
 * NULL-VS-UNDEFINED — this matches the live coalescing semantics of the
 * codebase rather than raw object spread, and the two differ:
 *
 *  - Every `??` / `??=` default site in the library (`summaryTargetTokens ?? 2000`,
 *    `this.config.mergeThreshold ??= 6`, ...) is nullish-coalescing, so `null`
 *    and `undefined` are treated identically: both mean "not supplied", and the
 *    lower layer's value stands.
 *  - `previewContext` states the same rule explicitly for its override merge,
 *    dropping `undefined` and `null` entries BEFORE spreading because a spread
 *    with `foldingStrategy: undefined` erases the live key: "Absence is the only
 *    way to mean 'keep the live value'."
 *
 * So a layer supplying `undefined` or `null` for a key does not win it and does
 * not steal a lower layer's win. A key no layer supplies non-nullishly is absent
 * from both maps — never present-as-undefined.
 *
 * Only own enumerable properties are read, and values are copied by reference:
 * the report shares object/array values with its layers rather than cloning.
 */
export function resolveEffectiveConfig(layers: ConfigLayer[]): EffectiveConfigReport {
  const effective: Record<string, unknown> = {};
  const provenance: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (value === undefined || value === null) continue;
      effective[key] = value;
      provenance[key] = layer.source;
    }
  }
  return { effective, provenance };
}
