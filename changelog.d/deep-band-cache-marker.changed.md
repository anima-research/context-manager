- Cache-marker placement on the adaptive compile, for every strategy but
  `kv-unified`: the first message-level breakpoint now sits at the end of
  the **deep band**, the leading run of recall pairs after the head
  rendered at the deepest level the compile emitted, instead of at the
  last head message. The level is the deepest over the whole middle, so a
  shallower leading run in front of a deeper summary leaves no band, and
  the head marker stays. Nothing that arrives rewrites the band: a new
  max-level summary lands after it, and a merge one level up is the rare
  exception. A deeper summary landing after it ends the band without
  changing a byte of it, and that turn marks the furthest entry the
  previous request marked that is still unchanged: the old band end, or a
  later mark. The solver can also re-cut the band's youngest group to a
  shallower level. Measured on a long-lived resident (2026-10-06), the
  head marker cached 244 tokens of bootstrap messages while 14 complete L3
  pairs (~73k tokens) sat unmarked behind it, and 24 of 51 large rewrites
  in a week re-read exactly the system+tools prefix. The band comes after
  the head, so the first slot's prefix contains the head and is never
  shorter than before. When the first slot moves, with a band before or
  after, the measured-stable-prefix marker goes to the furthest entry the
  previous request marked that is still in the unchanged prefix, unless
  the first slot already marks it, so the turn still reads what that
  request wrote: for example the head when a fold forms the band right
  after it, the band's old end when the group after the band deepens to
  its level or the band goes, or a later marker of the previous request
  when the change comes after it. Otherwise the measured-stable-prefix and
  end markers are unchanged, and the 3-marker first claim still holds.
  Repair stubs right after a head that ends in an unanswered tool call
  don't cost the band, until the call's genuine result is placed there
  instead. When neither a compile nor the one before it has a band,
  placement is byte-identical to before.
  **Trade on membrane's native formatter:** native marks the system block
  only when zero message markers arrive, so the head marker was the one
  marker covering tools+system+head there, and every turn read at least
  that from cache. With the band marker, a turn whose band changes inside
  it reads from cache on native only what an earlier request marked within
  what survived, usually *nothing* (before, it read tools+system+head). On
  the XML formatter membrane marks the system block itself on these
  requests, so a band change still reads tools+system.
  `kv-unified` keeps its 33/66/100 thirds.
