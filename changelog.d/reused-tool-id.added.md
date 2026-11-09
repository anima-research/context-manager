- `ContextEntry.relocatedBlocks` holds the result blocks pairing repair placed
  for an entry's `relocatedResults`, one for each move. Where it's set, compile
  provenance credits a moved result only through one of those blocks still in
  the request, unaltered, or through a result with its id still in the entry
  that isn't among the blocks repair recorded as placed for any entry.
  `AutobiographicalStrategy` and `KnowledgeStrategy` set it.
