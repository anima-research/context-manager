- **`carryStrandedSummaries` lets a summary no merge can take fold deeper**
  (off unless set; a strategy that doesn't set it merges as before). Merges
  take only neighbours of one level, so a summary left between higher
  summaries never merged again and parted the runs on its two sides, and so
  did one left out of merges as too wide for its level
  (`mergeMaxSourceSpanMessages`). With the option set, the merge check gives
  each such summary a parent one level up that is the same memory: its text,
  verbatim response blocks, token count, range, date and authoring request,
  with that summary as its one source and `carriedFrom` naming it
  (`SummaryEntry.carriedFrom`). No model is called. At the new level the
  entry joins a run and merges as any summary does, with an ordinary
  summarizer call over the run, or it is carried again; it stops at the
  level of the highest summary beside it.
  - A summary is carried only where an unparented summary of a higher level
    stands strictly beside it, nothing that held-up work could still fill
    stands beside it (a quarantined chunk, a quarantined merge, a hold: the
    `beside` of a stranded summary), and it is the one form of every message
    in its span. So a summary with another's messages inside its span, which
    the span limit exists to keep out of merges, is never carried to a level
    where that limit would pass it, nor is a superseded L1 generation.
  - A resident's own merge check reads each level's last run as the newest,
    which waits to grow, so a summary alone in it is not carried there.
    `drain-autobiographical` reads a run with a higher summary after it as
    one that can't grow, and carries it, when its recipe sets the option.
  - A compile never renders a carried entry. The selects read the summaries
    without them, the summary carried standing in the entry's place, so the
    window is what it was before the carry until a merge over the entry
    lands, and that merge's summary is then the next level those messages
    fold to. `searchSummaries` and `listSummariesInRange` read them the same
    way, so no memory is listed twice. A summarizer request names a carried
    entry by its own id, as it names any summary of that level, and answers
    with the text of the summary it carries as that summary stands. The
    entry's own copy of the text is not kept in step with it, so a repair
    that rewrites a carried summary in place edits that summary, and not the
    entries that carry it. The request for a transition summary leaves
    carried entries out, since they repeat a summary's text.
  - What reads the stored entries as they are: `getSummary` returns a
    carried entry for its id, names it as the parent of the summary it
    carries, and lists it among the sources of the merge that took it, where
    the two lists above name the summary carried in its place (so there a
    source can sit more than one level below its parent). The counts by
    level (`getStats`, `getProgressSnapshot`, the debt report's
    `unmergedFrontier`, `audit-topology`) count a carried entry at its level
    and the summary it carries as merged, as the merge check reads them, so
    a carry moves one from a level's count to the next with no change in
    what a compile sends. A carried L1 no longer counts toward
    `maxSpeculativeL1s`, as one a merge took doesn't.
  - A store that holds carried entries needs a context-manager that knows
    them. An earlier release reads each as an ordinary summary of its level:
    it renders the entry in place of the summary it carries and counts it as
    a deeper fold of those messages, so going back to one changes what a
    compile sends. Turning the option off does not: the entries stay, and
    are read as above.
  - `getStrandedSummaries()` no longer lists a summary the next merge check
    carries when the option is set. It reads the store as it stands, in one
    pass: a summary that check reaches only after carrying another beside it
    stays listed until the check has run, and `previewCarries()` follows
    every step.
  - `previewCarries()` lists what the rule would do to a store as it stands,
    writing nothing: each carry and each merge that would then land, in
    order, with the merge's sources and their tokens. The `--carry-preview`
    flag of `audit-topology` prints it, as the resident's own merge check
    reads the store, and `--carry-preview=drain` as a drain does. A drain
    compresses the chunks that wait before it carries or merges, and the
    preview doesn't project the L1s they land: read as a drain it counts
    those chunks (`chunksWaiting`, and a `provisional` line in the text
    output), and its steps hold only once they have landed.
  - `repair-topology`, `audit-topology` and the planner
    (`RepairRunsConfig.carryStrandedSummaries`) take the setting as
    `--carry-stranded-summaries`. A rebuild planned with it projects the
    carries the drain makes, so it dissolves no tower to partner a summary
    the drain will carry. With or without it, a repair no longer dissolves a
    parent that carries its one source as it dissolves a merge left with
    one. A carried entry a repair gives a second source (an adoption, a
    re-homed fragment) keeps `carriedFrom` and is read from then as a
    summary of its level over both, by the selects and the lists too.
    `inspect-store` marks carried entries in its summary tree, and
    `export-picker-inputs` exports the summaries as a select reads them.
