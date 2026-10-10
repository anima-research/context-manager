- kv-stable: the ideal cut's phase C (spend headroom by un-folding toward the
  target) now walks chunks youngest-first by **position**, whatever their
  level, and repeats passes so the youngest group can step down more than one
  level before an older one is touched. It used to walk deepest level first
  (`for level = max..1 { youngest-first }`), which raised the youngest L3
  group — the one right after the deep band — before any L1 at the seam, so
  on a chronological layout every un-fold was a front edit, and the dead band
  could not hold because the from-scratch ideal always wanted that group one
  level shallower than the carried frontier. Measured on a long-lived
  resident (`[fold-diff]`, 2026-10-07..09): the group at the L2↔L3 boundary
  flapped L3→L2→L3 seven times in three days, each direction re-reading
  ~300k tokens, while a fold confined to the seam cost ~97k. The accept rule
  (closer to target, under W), group consistency, protections and the
  phase A/B fold order are unchanged; only which group is tried first when
  there is headroom to spend.
