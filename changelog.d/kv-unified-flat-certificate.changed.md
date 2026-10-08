- The kv-unified warm compile does less fixed work per turn. The hysteresis
  certificate walks its DAG as flat typed arrays (grown in place when leaves
  are appended), keys fully owned summary contexts by summary id instead of a
  serialized id list, and tests participants by allowed-level bits; the
  terminal evaluator keeps the per-leaf slot facts that depend only on the
  leaf and its receipt entry across compiles and recomputes only the
  age-dependent terms; the certificate and the evaluator share one receipt
  lookup per leaf. The minimum-token floor (every uncertified compile and
  every budget-wall turn of a pinned store) uses the same id keys and bit
  tests. Forest derive compares head/tail zones with one byte per leaf and
  reads unchanged leaves by position; the strategy's compile loops memoize
  L1-to-ancestor walks, read forest leaves by sequence, and check coverage
  by position. All sums run in the original order: layouts, resolutions,
  receipts and emitted entries are unchanged.
