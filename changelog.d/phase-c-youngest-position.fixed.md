- kv-stable: the ideal cut no longer flaps a deep group at a band boundary.
  Two changes, measured together on a long-lived resident with `[fold-diff]`
  (2026-10-07..09: the group at the L2↔L3 boundary went L3→L2→L3 seven times
  in three days, each direction re-reading ~300k tokens; a fold confined to
  the seam cost ~97k) and on a carried-growth replay (1,296 base-6 leaves at
  50 raw / 100 recall, one appended leaf per turn, a summary every six, every
  frontier carried; 120 turns at target 1600 / W 2150: no deep group is ever
  raised, total re-read 20,000 against 22,500 on the previous release and
  25,900 with the new walk but seeding off):
  - **Phase C** (spend headroom by un-folding toward the target) walks chunks
    youngest-first by **position**, whatever their level, and restarts from
    the youngest after every accepted un-fold, so the youngest group steps
    down L2→L1→raw before any older group is tried. It used to walk deepest
    level first (`for level = max..1 { youngest-first }`), which raised the
    youngest L3 group — the one right after the deep band — before any L1 at
    the seam.
  - **The ideal cut is seeded from the carried frontier**
    (`kvStableSeedFromCarried`, default `true`): phases A/B only deepen what
    is carried (same salience-then-oldest, level-by-level order) and only
    phase C un-folds. The from-scratch cut re-decided every band boundary
    from the current balance of production and growth, so a deep group was
    raised when a new mid-level summary landed and re-deepened when growth
    crossed W — and the dead-band hold could not keep it, because its
    relevance-gap check compared against that moving ideal. An inverted
    carried profile (a chunk deeper than an older unprotected chunk) is still
    lowered to the older level so the quality-gap self-heal keeps working;
    an older chunk already at the deepest level its group can render at
    (lineage top, or a pin-max-level on a group-mate) is no evidence of
    inversion, and a fold the seeded base already holds gets the same
    overlap exemptions a fold made in the compile gets — without either, a
    seeded plan could alternate between two frontiers on an imperfect tree.
    Bootstrap is unchanged. `kvStableSeedFromCarried: false` restores the
    from-scratch ideal of design §13.4 while keeping the new phase-C walk; it
    is not a rollback to the previous release's planner.
  - **Cost, stated:** keeping monotone over-depth IS the hysteresis, and the
    quality-gap check cannot see it (relevance loss only scores depth past
    the age cap, and the seeded ideal keeps the carried depth). Depth the
    budget once forced persists until the seam runs out of headroom; on the
    replay the seeded plan's loss exceeded the from-scratch ceiling on 217 of
    400 turns. When the budget is raised enough that the seeded plan would
    pay at least 90% of a from-scratch re-cut's re-read anyway, the
    from-scratch cut is taken instead, so a large raise is not spent keeping
    a tight-budget allocation.
  Accept rule, group consistency, protections and the phase A/B fold order
  are unchanged. `kv-unified` is untouched.
