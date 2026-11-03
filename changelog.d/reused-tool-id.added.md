- `ContextEntry.relocatedBlocks` holds the result blocks pairing repair
  placed for an entry's `relocatedResults`, one for each move. Where it's
  set, attribution credits a moved result only through one of those blocks
  still in the request, unaltered, or through a result with its id still in
  the entry, so another result with the same id and content doesn't stand
  in for it. `AutobiographicalStrategy` and `KnowledgeStrategy` set it.
