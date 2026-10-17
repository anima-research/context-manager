- **TypeScript callers that write to a compile's provenance:** its `layout`
  (`RenderedLayout`, `LayoutUnit`), its `branch` and every other `BranchRef`,
  its `journalMark`, and its `compileId`, `namespace` and `strategy` are
  read-only. Code that assigns to them, changes their arrays, or passes one of
  their arrays where a mutable array is expected stops compiling. Acceptance
  reads and records what they say, and the mark steers its search for an
  earlier acceptance, so such a write before accepting changed what it
  recorded. Copy before changing. Unchanged: the per-message sources in
  `messages` stay writable, and reading these parts compiles as before.
