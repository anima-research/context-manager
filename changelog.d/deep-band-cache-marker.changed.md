- Cache-marker placement: the first message-level breakpoint now sits at the
  end of the **deep band** — the leading run of recall pairs, right after the
  head, rendered at the deepest level the compile emitted — instead of at the
  last head message. The band is the cheapest stable prefix after system+tools:
  a new max-level summary lands after it and the solver never re-cuts below
  the deepest level it already chose (a merge one level up is the rare
  exception). Measured on a long-lived resident (2026-10-06), the head marker
  cached 244 tokens of bootstrap messages while 14 complete L3 pairs (~73k
  tokens) sat unmarked behind it, and 24 of 51 large rewrites in a week
  re-read exactly the system+tools prefix. The band contains the head, so the
  first slot's cached prefix only grows; the measured-stable-prefix and end
  markers are unchanged, and the 3-marker first claim still holds. With no
  summary emitted (fresh stores, pure raw windows) placement is byte-identical
  to before.
  Under `foldingStrategy: 'kv-unified'` the same band becomes the first of
  the four owned slots and the mid marker moves to the token midpoint between
  the band and `historyEnd` (unified-solve-design.md §5A.3's v1 layout:
  system+deep-band | mid-history | historyEnd | end); without a band the
  33/66/100 thirds are unchanged. `deepBandEnd` is a protected hook.
