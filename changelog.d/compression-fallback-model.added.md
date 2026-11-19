- **`compressionFallbackModel`** (unset by default; a deployment that leaves
  it unset compresses as before) names a model to ask once the compression
  model has refused on every rung that keeps it writing the memory in full.
  For an L1 the rung comes after the canonical request, the tool-prose hoist,
  the recall variants and source-only-final with its hoist, and before the
  split rung and quarantine; for a merge it comes after the last of
  `mergeAttemptLimit` attempts, in place of quarantine, as one more attempt.
  It sends the canonical request (a merge's first attempt) with only the
  model changed, so the fallback model takes the same `max_tokens`, tools and
  reasoning carriers, and nothing is added to what either model reads.
  - Only refusals lead to it: where any rung or merge attempt ended in a
    provider error or a truncated or empty generation, the ladder runs as
    before, and an overload interrupts it as before. A recall variant that admission kept from
    being sent doesn't stand in the way.
  - Its memory is stored as text alone: the reasoning blocks of its answer
    aren't kept (the entry has no `responseContent`), since a memory's
    reasoning is replayed to the agent's model and to the compression model,
    and neither can be given reasoning another model signed. The entry's
    existing `provenance.model` names the fallback model. If it refuses too,
    the split rung (where on) and quarantine follow as before.
  - Setting or changing it is a new request regime for L1 compression, so a
    chunk already in the compression quarantine gets a fresh bounded attempt,
    which runs the compression model's rungs again first. A merge in the
    merge quarantine is not retried by it: `clearMergeQuarantine` is.
  - It logs `compression:fallback-model` with the outcome for an L1, and
    `merge:fallback-model` when a merge's rung runs; each attempt's receipt
    names the model it was sent to.
  - The memory is then written in the agent's voice by another model, which
    this library never does unless told to: set it knowing that.
