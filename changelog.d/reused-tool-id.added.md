- `ContextEntry.relocatedBlocks` holds the result blocks pairing repair
  placed for an entry's `relocatedResults`, one for each move. Where it's
  set, attribution credits a moved result only through one of those blocks
  still in the request, unaltered, or through a result with its id still in
  the entry that isn't among the blocks repair recorded as placed for any
  entry. A stub repair generated, or a copy that releasing a raw form made of
  a block it placed, isn't recorded, so either counts as a carrier wherever it
  covers the moved result.
  `AutobiographicalStrategy` and `KnowledgeStrategy` set it.
