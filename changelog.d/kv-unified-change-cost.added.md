- **kv-unified can price what a change of layout costs** (all off unless
  set; a deployment that sets none solves as before):
  - `kvUnified.policy.rewriteLambda` prices cache churn linearly, per
    `cacheScale`, in place of the quadratic `cacheLambda` term, which at the
    scales in use is nearly flat where layouts differ by a few hundred
    thousand tokens of rewrite. With it the layout last accepted is cheaper
    than any change by that change's whole rewrite, and a change that keeps
    the earlier cache breakpoints is cheaper by what stands before them, so
    a transition folds new history without also re-leveling old summaries
    or folding a stray old message, unless that is worth its rewrite (old
    history still returns to a shallower level where it is). On a copy of
    one resident's store, with a transition forced by a steeper over-budget
    penalty than deployments run, the first changed token moved from 3k to
    232k (a rewrite of 262k tokens instead of 505k), and the layout held
    four turns longer, moving at 590k instead of 564k. The same copy kept its first
    change at the new fold with `cacheScale` lowered to 10,000 or 20,000
    and no code change, so the quadratic's scale is the other remedy; it
    was not measured what that does to which merges are demanded.
  - `kvUnified.thinkingLambda` (with `thinkingHalfLifeTokens`, 50,000
    unless set) prices the thinking a change would drop, on a compile for a
    model that binds thinking (`SelectOptions.thinkingBinding.binds`). Any
    change of layout drops all of the thinking still in play, wherever the
    change begins, so the cost is the same for every change and is added
    to `adoptEpsilon` for that compile: it decides whether to change, never
    which change. It is counted from what the branch's binding record still
    vouches for, weighted by how far back each reply is, so it is zero
    once the thinking is gone anyway (another system text or tool list),
    and a transition that was waiting comes then. `[plan-vs-actual]` shows
    it as `changePenalty=`, and `RenderStats.planVsActual.changePenalty`
    carries it.
  - The context manager gives the select of a binding compile what the
    record says of its replies' thinking before anything is selected
    (`SelectOptions.thinkingStanding`, a new `ThinkingStanding`), as it
    gives `messageInjections`: a caller's value is dropped. It changes
    nothing about what a compile leaves out.
  - Latent demand is decided without either price, so the same merges are
    demanded as without them. Where the live solve priced a change and was
    not certified, that costs one more base solve over the same labels on
    a compile with merge candidates.
  - The hysteresis certificate counts the least rewrite a change pays
    (`certificate.rewriteFloor`), which is the rewrite of the recent
    window, so it decides more of the compiles in which a priced layout
    holds. A compile it can't decide runs the full solve, as before, and
    its bound is well under what a change really costs: on the copy above
    the full solve ran, at about half a second more per compile, on each
    turn between where the unpriced policy would have moved and where the
    priced one did.
  - Not changed: where a transition lands (`budgetHighRatio`), the hard
    wall, and which summaries may be taken (a summary over messages a
    window sends raw has been left out since 0.24.1).
