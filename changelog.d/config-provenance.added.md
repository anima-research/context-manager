- Effective configuration is now readable, with the layer that supplied each
  key: `resolveEffectiveConfig(layers, semantics)` collapses ordered named
  layers into `{ effective, provenance }`, and `strategy.configProvenance`
  exposes that map for an autobiographical or knowledge instance
  (`'library-default'`, `'caller'`, `'knowledge-enforced'`, or whatever a host
  names its own layers). Values previously coalesced through `??`-chains across
  52 default sites, so the effective value of a key was recoverable only by
  reconstructing the chain by hand and the layer that supplied it was not
  recoverable at all. `semantics` is stated per call rather than assumed:
  `'skip-nullish'` reads a layer's `undefined`/`null` as "not supplied" (the
  `??` rule, and what a host stacking env/profile layers wants), while
  `'spread-fidelity'` lets a layer's own keys win exactly as
  `{ ...defaults, ...caller }` assigns them. The strategies resolve with
  spread fidelity, which is what their constructors always did, so no caller's
  effective config changed — including callers passing an explicit `undefined`
  or `null`, where the two readings differ.
- New option `logEffectiveConfig` (default `false`): one structured
  `config:effective` line on stderr carrying every effective key with its
  source, for operators who want the resolved picture in their logs rather than
  through a debugger. It is emitted at strategy initialization rather than at
  construction, so a subclass instance reports the strategy it actually is.
  The line carries a third field, `presentAsUndefined`: keys a caller supplied
  as explicit `undefined` stay present in the effective config but cannot
  survive JSON, so they are named there instead — every provenance key is
  either valued in `effective` or listed in `presentAsUndefined`, never both.
