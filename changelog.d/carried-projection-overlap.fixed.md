- kv-stable: on a store whose summary tree isn't nested (where
  `[kv-overlap]` warns), the next compile no longer un-folds a summary around
  a leaf that the summary lists but whose own lineage doesn't run through it,
  or around a leaf of its own folded above it. The validity projection now
  decides both from the tree, for the carried frontier and each
  suffix-adoption candidate as for the ideal cut: a leaf vetoes a summary
  only when it renders below the summary's level and the summary is its own
  lineage there. Before, a plan that held re-laid the window from that
  summary on, on unchanged inputs, and reported a perturbation of 0; a plan
  that adopted the same frontier again reported a fold and a perturbation it
  hadn't made; and suffix adoption could never take such a summary. On such
  a store a plan can now also keep a summary folded where it used to render
  that summary's leaves raw, since the solve's own exemption covered only
  the leaves its folds had met. LariTesserae's #130 named the re-layout.
- kv-stable: a compile no longer leaves a leaf at a level whose own-lineage
  summary doesn't list it, on any store. A level carried from before a
  summary was written again without one of its sources, a lock or a pin
  could point there, and so could a fresh plan's passes on a store whose tree
  isn't nested. The leaf's recall didn't hold it, and where no other recall
  did, the turn was refused with `UncoveredDropError`. The projection now
  lowers such a leaf, and the base lowers a locked or pinned leaf's level the
  same way, so a lock or a pin can now render below the level it holds when
  the summary there doesn't list the leaf. A held level with no summary at
  all is kept, as before, and renders raw. For a pin-at-level
  (`pinAtLevel`, `ProtectedRange.level`), kv-stable now lowers the level the
  same way before it holds the pin's summary there, so a summary it holds for
  the pin lists the pinned chunk, and the chunk is held with that summary's
  other leaves. It used to hold the leaves of the summary that doesn't list
  the chunk, which nothing pins, and leave the pinned chunk unheld, so it
  rendered raw when there was room.
- kv-stable: where two pins-at-level overlap a chunk and one of them holds it
  at a level where its lineage has no summary, the finer level now holds it.
  The other pin used to replace the finer level when kv-stable read it
  second, and the chunk rendered raw, with the picker reporting a level it
  can't realize.
- kv-stable: on a store whose summary tree isn't nested, the solve's
  un-fold pass now moves the leaves a summary renders, decided by each
  leaf's own lineage as the projection decides. It used to leave out any
  leaf that some fold in the same compile had met under another lineage,
  and could then settle on a plan above `foldAt`, the same on every
  compile. A fold decides the same way: a listed leaf of another lineage,
  which the fold doesn't move, no longer vetoes it with its pin-max-level or
  its fold-depth cap.
- kv-stable: the solve's un-fold pass now weighs each leaf it moves where the
  projection will put it: one level down, or deeper, past a level where the
  leaf's lineage has no summary and past a summary that a leaf below it
  vetoes, down to the next level whose summary of the leaf's own lineage lists
  it and isn't vetoed, or to raw. It weighed every leaf one level down. Where
  a summary in the leaf's lineage names a parent more than one level up, so
  its lineage has no summary there, it counted the leaf as raw and could
  decline an un-fold that would have brought the plan closer to its target.
  Where a leaf below vetoed the summary there, the plan it took wasn't the one
  the projection rendered, and a compile could end exhausted where a plan fit.
- kv-stable: `[kv-overlap]` now reads the frontier the plan emits. It warns
  for every plan whose frontier renders a summary whose listing disagrees with
  the lineage of a leaf in the window, and only then: the summary lists a leaf
  of another lineage, or a leaf's own lineage runs through it and it doesn't
  list the leaf, as after the summary was written again without one of its
  sources. The second case has a line of its own, which says that listing and
  lineage disagree. It also warns for the shadow production pick's plan, which
  no compile renders: a compile that isn't a dry run makes that pick when
  `productionBudgetTokens` is set below its budget. It used to report the
  folds the compile made, so a plan that kept the carried folds could render
  the overlap without a warning, a plan that didn't render it could still
  warn, and a summary that had lost a source never warned. A lock or a pin can
  still hold a leaf beside a summary of its own lineage that lists it, which
  renders the leaf in both recalls without a warning.
- kv-stable: a locked chunk with a pin-max-level is lowered to the cap at
  plan start, as the cap promises. It used to keep its carried level above
  the cap. A chunk under another range's pin-at-level keeps that level, as
  before, since kv-stable fixes the pin's whole node there.
- kv-stable: an unlocked chunk's level carried far above the summary tree's
  top is now lowered in one compile to a level its summaries render. A plan
  that held it could emit a level with no summary, which renders raw, and
  the next compile then rendered the summary while reporting a perturbation
  of 0.
