- Compile provenance attributes a moved result of an entry that sets
  `relocatedResults` and no `relocatedBlocks` by tool_use id, as the field's
  doc says, against every result with that id in the request. It checked only
  the first, so where a later call reused the id, a moved result that sat
  unaltered in the request could read as missing.
