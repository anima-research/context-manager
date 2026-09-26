- `repair-topology --rebuild-since <messageId|ISO date>`: in rebuild mode,
  only crossed summaries whose span starts at or after that message are
  dissolved for the ladder to re-fold; older ones get the compact treatment,
  so regions that were repaired by hand are never re-summarized. The plan
  reports where the cutoff landed and how the crossed set split.
- compact mode adopts hole owners downward: a root of any lower level that
  owns a hole is taken into the descendant one level above it whose span is
  adjacent, so a small hole deep inside a tall tower closes where it is and
  nothing above unravels.
