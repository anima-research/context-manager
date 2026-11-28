- **Callers of `editSummaryText`, and operators of `external-memory edit`:**
  an edit of a summary that holds verbatim response blocks, or whose
  carrier holds them, is refused unless it sets `dropResponseContent`
  (`--drop-response-content`), which deletes them from the summary and each
  carrier. The blocks render in place of the text, so an edit that kept
  them wouldn't show. In 0.29.0 the edit deleted them without being asked.
  An edit of an entry that carries another summary up a level
  (`carriedFrom`) is refused where the strategy holds that summary, and the
  error names it: a compile reads that summary's text in the entry's place,
  so such an edit never showed. `SummaryTextEdit.parents` no longer lists
  the entries that carry the edited summary: they are in `carriedBy`, and
  the CLI prints them on a line of their own. In 0.29.0 `parents` listed
  them with the summaries merged over the old text. To migrate, set
  `dropResponseContent` where deleting the blocks is meant, edit the
  carried summary rather than its carrier, and read `carriedBy` beside
  `parents` for every entry that an edit reaches. A strategy that
  implements `ExternalMemoryStrategy` returns `carriedBy` from its
  `editSummaryText` too: the entries that carry the edited summary, or an
  empty list. Nothing else changes for
  an edit of any other summary: it keeps the lineage, and stamps tokens
  from the new text's length.
