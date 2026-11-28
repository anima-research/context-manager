- `editSummaryText` takes `SummaryTextEditOptions` (now exported):
  `expectedPriorSha256` refuses the edit where the summary's text has
  another sha256, beside `apply` and `dropResponseContent`. The CLI's
  `external-memory edit` takes `--expected-prior-sha256`, and its dry run
  ends with the apply command, which carries the sha256 of the old text
  that the dry run read. `SummaryTextEdit` lists the entries that carry the
  summary (`carriedBy`), apart from the summaries merged over it
  (`parents`).
