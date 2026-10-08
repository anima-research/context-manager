- Large-history compiles do less per-compile work over the whole store: the
  message listing survives receipt and resolution writes (it keyed on the
  store-global sequence), filtered views share one filtered array per
  listing, chunk rebuilds use one id-to-position map (extended in place on
  append) and record which chunk owns each position, pins and the picker
  inputs read those instead of building their own maps, and the L1-by-message
  index is rebuilt only when summaries change. The hysteresis certificate
  prices and scores its carried cut as a levels array instead of 75k id
  tuples and a frontier map; the terminal evaluator takes the forest's chunk
  order instead of re-sorting and factors the per-leaf loss terms out of the
  per-level loop (values are bit-identical). Layouts are unchanged.
