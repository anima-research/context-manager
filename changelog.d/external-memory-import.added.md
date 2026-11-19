- **A memory whose text was written outside the strategy's own compression
  calls can be installed or edited**, for work the provider refuses on every
  attempt. `scripts/external-memory.ts` does it on a stopped resident's
  store, a dry run unless `--apply` is given:
  - `export-request` writes the request the strategy would send now for one
    piece of work, the next merge into a level or the L1 of a chunk record
    (quarantined or not), with a descriptor of the work. Nothing is sent or
    written to the memory: work the strategy would only reach by changing
    its own state first (say a group with a held source, which it would
    skip, queuing the merge beside it) is refused, and the change isn't
    made.
  - `import` installs a text as the summary of that work, and only while the
    strategy would still do the same work and builds the same request for
    it (the descriptor carries the request's sha256): the tree's shape stays
    the strategy's, and a text written for a request whose history or
    recalled memories have changed since is refused. A dry run builds the
    request and makes the same checks. The text takes the place of the
    provider's answer, so the summary is written as a native one is
    (lineage, its sources' parent, the chunk record, tokens stamped from the
    text, the quarantine of its chunk or merge paid off). It is stored as
    the file holds it, less the whitespace that ends it: no thinking wrapper
    is read out of it as out of a model's answer. It carries no reasoning.
  - `edit` replaces the text of one summary by id, with the file's text
    stored the same way: lineage untouched, tokens stamped from the new
    text, and what described the call that wrote the old text dropped (its
    verbatim response blocks, its `provenance`, its split-stitch record).
    The summaries merged over the old text are reported and left as they
    are.

  `SummaryEntry.external` (`{ by, at, note?, requestHash? }`, optional)
  records who supplied such a text, and for an installed one the sha256 of
  the request it answers. An entry that has it has no `provenance`, which
  stays what it was: the record of a model's accepted answer. Entries
  without `external` are unchanged, nothing renders it and no selection
  reads it. The operations are also methods:
  `ContextManager.exportMemoryRequest`, `importExternalMemory` and
  `editSummaryText`, over the strategy's methods of the same names
  (`isExternalMemoryStrategy`), with the types `MemoryWorkItem`,
  `MemoryWorkTarget`, `ExternalMemoryProvenance` and `SummaryTextEdit`. They
  are for a resident that isn't running, called with no tick or other
  compression in progress on the manager: none waits for compression in
  flight, or is kept apart from it.
