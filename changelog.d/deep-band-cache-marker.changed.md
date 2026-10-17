- Cache-marker placement: the first message-level breakpoint now sits at the
  end of the **deep band** — the leading run of recall pairs, right after the
  head, rendered at the deepest level the compile emitted (the deepest over
  the whole middle: a shallower leading run in front of a deeper summary
  leaves no band, and the head marker stays) — instead of at the last head
  message. The band is the cheapest stable prefix after system+tools —
  nothing *arrives* to change it (a new max-level summary lands after it; a
  merge one level up is the rare exception) — but not an immutable one: the
  solver may still lower the band's youngest group when the budget no longer
  needs it, and the measured-stable-prefix marker covers what survives such a
  turn. Measured on a long-lived resident (2026-10-06), the head marker
  cached 244 tokens of bootstrap messages while 14 complete L3 pairs (~73k
  tokens) sat unmarked behind it, and 24 of 51 large rewrites in a week
  re-read exactly the system+tools prefix. The band starts right after the
  head, so on the legacy (non-kv-unified) path the first slot's prefix
  contains the head and is never shorter than before; the
  measured-stable-prefix and end markers are unchanged, and the 3-marker
  first claim still holds. With no summary emitted (fresh stores, pure raw
  windows) placement is byte-identical to before.
  **Trade on membrane's native formatter:** native marks the system block
  only when zero message markers arrive, so the head marker was the one
  marker covering tools+system+head there, and every turn read at least that
  from cache. With the band marker, a turn whose band changes reads
  *nothing* from cache on native (before, it read tools+system+head). On the
  XML formatter membrane marks the system block on every request, so a band
  change still reads tools+system. Recommended to land after #156, which
  stops the solver raises that change the band.
  Under `foldingStrategy: 'kv-unified'` the same band becomes the first of
  the four owned slots and the mid marker moves to the legal boundary nearest
  the token midpoint between the band end and `historyEnd`; with no legal
  boundary after the band (or a band reaching `historyEnd`) the mid and
  history slots collapse onto the band marker. The slots are
  unified-solve-design.md §5A.3's v1 layout (system+deep-band | mid-history |
  historyEnd | end); the mid marker does *not* follow §5A.4's
  before-the-earliest-pending-landing rule, only its token-midpoint fallback.
  Here the first slot moves from the boundary nearest 33% of history to the
  band end, so a short band gives a *shorter* first prefix than before.
  Without a band the 33/66/100 thirds are unchanged. `deepBandEnd` is a
  protected hook.
