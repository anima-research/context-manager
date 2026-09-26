- `repair-topology --rebuild-since <messageId|ISO date>`: in rebuild mode,
  only crossed summaries whose span starts at or after that message are
  dissolved for the ladder to re-fold; older ones get the compact treatment,
  so regions that were repaired by hand are never re-summarized. The plan
  reports where the cutoff landed and how the crossed set split.
