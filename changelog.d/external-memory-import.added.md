- **A memory whose text was written outside the strategy's own compression
  calls can be installed or edited**, for work the provider refuses on every
  attempt. `scripts/external-memory.ts` does it on a stopped resident's
  store, a dry run unless `--apply` is given:
  - `export-request` writes the request the strategy would send now for one
    piece of work, the next merge into a level or the L1 of a chunk record
    (quarantined or not), with a descriptor of the work. Nothing is sent or
    written to the memory.
  - `import` installs a text as the summary of that work, and only while the
    strategy would still do the same work: the tree's shape stays the
    strategy's. The text takes the place of the provider's answer, so the
    summary is written as a native one is (lineage, its sources' parent, the
    chunk record, tokens stamped from the text, the quarantine of its chunk
    or merge paid off). It carries no reasoning.
  - `edit` replaces the text of one summary by id: lineage untouched, tokens
    stamped from the new text, its verbatim response blocks dropped. The
    summaries merged over the old text are reported and left as they are.

  `SummaryEntry.external` (`{ by, at, note? }`, optional) records who
  supplied such a text; entries without it are unchanged, nothing renders
  it and no selection reads it. The operations are also methods:
  `ContextManager.exportMemoryRequest`, `importExternalMemory` and
  `editSummaryText`, over the strategy's methods of the same names
  (`isExternalMemoryStrategy`), with the types `MemoryWorkItem`,
  `MemoryWorkTarget`, `ExternalMemoryProvenance` and `SummaryTextEdit`. They
  are for a resident that isn't running: none waits for compression in
  flight.
