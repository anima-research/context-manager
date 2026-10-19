# As-of compression recall-curve fallback

Status: external-development specification
Author: Sol (experiment/design), 2026-07-15
Target: `@animalabs/context-manager`, primarily `AutobiographicalStrategy.compressChunkHierarchical()`

## Problem

Autobiographical L1 compression constructs an as-of memory-write request from:

1. the raw identity head;
2. the current unmerged authored-memory frontier as Context Manager recall pairs;
3. uncovered raw middle;
4. the compression marker;
5. the raw target chunk;
6. the memory-write instruction.

For Mythos, the canonical request began returning Anthropic `stop_reason: refusal`, category `reasoning_extraction`. The target chunk and primary conversational lane were healthy. Repeated speculative/maintenance ticks retried stable request hashes many times, leaving the chunk raw and threatening eventual context-budget failure.

Removing recall, private state, or using a neutral/alternate model is prohibited. Memory must be written by the as-of instance with semantic and preferably asemantic continuity: same model, identity head, authored memories, raw target experience, tools, chronology, and information coverage.

## Experimental result

Source: retained failed `complete()` request from Mythos, model `claude-fable-5`. No output was written to Chronicle.

All experiments preserved the same model, head, raw chunk (including private control state), tool inventory, instruction, chronology, and prior-history leaf coverage. Only one existing authored summary node was replaced by its direct authored children.

| Variant | Request messages | Input tokens | Result |
|---|---:|---:|---|
| canonical | 31–33 depending current frontier | ~62–65k | refusal: `reasoning_extraction` |
| expand `L4-443` → six L3 children | 43 | 86,496 | refusal: `reasoning_extraction` |
| expand `L3-544` → six L2 children | 43 | 83,266 | refusal: `reasoning_extraction` |
| expand `L3-458` → six L2 children | 43 | 81,755 | **success: `end_turn`, thinking + 2,765-token text** |

Successful request hash:

`85ace7bf091c41150671ef4346891ee739275b3f9f28e3ed30fe29de7fcf20eb`

This demonstrates a prefix/KV-shape boundary, not a content-presence boundary. Equivalent source coverage can succeed at another already-authored recall resolution.

## Non-negotiable invariants

1. **Canonical first.** Always issue the current canonical compression request unchanged. Fallback activates only after the canonical stage ends without a summary: a refusal or an incomplete answer takes the bounded curve, and a rejection attributable to the request, or a rung decided by its failures (see 10), goes to source-only-final once when that rung is configured, and otherwise exhausts the family.
2. **Same as-of model.** Do not use a neutral observer or alternate model/provider.
3. **No semantic omission.** Preserve head, raw middle, target chunk, tool cycles, instruction, and all leaf-history coverage selected by the canonical recall frontier.
4. **No private-state sanitization.** Do not remove, redact, deduplicate, or placeholder `think`, `skip_reply`, thinking, tool, or other state as part of this feature.
5. **Authored nodes only.** Alternate curves may use only summaries already authored and persisted by this instance. No mechanical or external summary may be introduced.
6. **Chronology preserved.** Replacement children occupy the parent node’s exact chronological position and remain ordered by source range.
7. **No future leakage.** The alternate request must retain the same as-of boundary; no tail-after-chunk.
8. **Coverage proof.** A replacement is valid only if recursively expanded leaf message IDs exactly equal the parent’s leaf coverage.
9. **Store once.** Only the first successful response may become the chunk’s L1 summary. Refused/aborted diagnostic outputs are never persisted as memory.
10. **Bounded where it is decided.** A deterministic outcome (an answer, a rejection attributable to the request, or a rung decided by `COMPRESSION_PERSISTENT_FAILURES` transient failures: its first, and each later one after compression landed on the same membrane and model since the one before) is recorded durably and never requested again, and the family exhausts after its bounded curve. Split-stitch is one exception: it is one retry unit, so a transient failure inside it re-runs the whole rung, the pieces it had settled included. A compression hold placed during a call is the other: it discards the call's answer before anything records it, so the chunk is asked for again once the hold is released. A transient failure decides nothing by itself: it is paced by the lane's backoff and any wait the provider stated, and counted only within the process. So however long an outage lasts, it adds at most one failure to a run, which decides the rung only where it is the run's eighth, and a restart starts every run again. Meanwhile the same request is retried with pacing.

## Fallback algorithm

### Canonical request

Build and issue the request exactly as current `compressChunkHierarchical()` does.

If the canonical stage answers `end_turn` with persistable text, mint it as before. A refusal or an incomplete answer takes the bounded curve below. A request-attributable rejection, or a rung its failures decided, goes to source-only-final once (see Durable refusal quarantine), and an answer whose text strips to empty gets one plain-prose retry.

On a refusal or an incomplete answer, retain the complete canonical request and canonical selected recall frontier for variant construction.

### Candidate nodes

From canonical `keptSummaries`, select entries satisfying:

- `level > 1`;
- every direct `sourceId` resolves to a persisted, nonempty child summary;
- recursive child leaf coverage exactly equals parent leaf coverage;
- replacing parent with children keeps the request under the configured compression/model input budget.

Order candidates deterministically:

1. newest source range first;
2. then higher level first;
3. then stable summary ID ordering.

This ordering would have tested `L3-458` early in the Mythos incident.

### Variant construction

For one candidate at a time:

- locate canonical pair:
  - Context Manager: `[CM] Recall memory <parent>.`
  - assistant: `<parent.content>`
- replace that pair with, for each direct child in source order:
  - Context Manager: `[CM] Recall memory <child>.`
  - assistant: `<child.content>`
- leave every other normalized message and tool declaration unchanged;
- rerun ordinary API-shape validation (tool pairs, nonempty text, image-byte budget) without semantic transformation;
- issue `complete()` using the same model/config/tools.

Default maximum: 3 fallback variants. Make configurable, e.g.:

`compressionRefusalCurveFallbacks?: number` (default `3`; `0` disables).

Fallback admission uses `compressionContextBudgetTokens` (default `200000`),
the combined model context budget for request input plus the configured
`maxTokens` output reserve. The canonical request is still issued unchanged.
Admission is deterministic before inference. Before authoritative canonical
usage exists, it uses a conservative UTF-8-byte bound over every input-bearing
field of the complete normalized variant (head, recall, raw middle, chunk,
tools, instruction, system/provider fields), a per-message formatter-envelope
allowance, and the output reserve. After canonical refusal reports complete
provider input usage, v2 admission uses `provider total input + positive
serialized expansion delta + output reserve`; the complete-request bound
remains the fail-closed path when usage is absent, has no input count, or
totals zero. Through `complete()`, which compression calls, membrane's
Anthropic and Bedrock adapters pass the provider's input count through, so
a missing one arrives as missing. Its other adapters report an omitted
count as zero, so a cache-only report reads as a full cache hit, which a
response can't tell from an omitted count. The
provider total is `inputTokens +
cacheCreationTokens + cacheReadTokens` for every provider: membrane (0.6.0
and later, in the host's instance) states the counts as disjoint wherever it
knows the convention, subtracting the cached span from `inputTokens` for
providers that report it inside, such as OpenAI and Gemini. A usage whose
convention membrane can't establish keeps its provider's counts: in 0.6.0
that's openai-compatible's and openai-completions', which never report cache
reads, and an OpenRouter response with no cache field. So its total is its
input count.
Physical request-byte enforcement remains a separate provider/transport
constraint. A positive complete provider total is authoritative even when it is
smaller than the deterministic byte bound: canonical refusal proves that exact
unchanged request was accepted and counted, and a fallback provider error stays
inside the bounded attempt curve. Stored `SummaryEntry.tokens` are never
admission authority.
The ordered plan records every rejection and at most the normalized positive
fallback limit of provider attempts. An over-budget variant is recorded and
skipped without preventing a later eligible variant.

Stop at the first non-refusal response containing persistable nonempty memory
text. A refused, empty, or deterministically rejected variant (a provider error
attributable to the request: `context_length`, `invalid_request`, `safety`,
`unsupported`) is recorded and the bounded curve continues. A transient provider
failure (capacity, transport, credentials, or anything unclassified) is not by
itself evidence about the variant: the curve stops there, keeps the family's
durable progress, pauses the compression lane, and a later tick resumes at that
variant without repeating requests whose outcomes are recorded. Only
`COMPRESSION_PERSISTENT_FAILURES` of them on one rung decide it, the first and
each later one after compression landed on the same membrane and model since
the one before: their outcome,
`provider_error:persistent-<class>`, is recorded like a rejection. A canonical rejection
attributable to the request skips the variants and the canonical hoist: it goes
to source-only-final once when that rung is configured, and otherwise exhausts
the family.

### Optional later variants

Only after single-node direct expansions are tested:

- uniform maximum-level curve (expand every node above level N);
- two-node expansion combinations.

Do not include these in v1 unless single-node expansion proves insufficient across real incidents; combinatorics and prompt size grow quickly.

## Durable refusal quarantine

A family exhausts when its ladder ends without a summary, in one of three
ways:

- the canonical stage refuses or answers incompletely, and every later rung
  the ladder reaches ends without one: the canonical's tool-prose hoist
  (when the canonical's own first call refused; a refusal of its no-tools
  or tools-less retry leaves the stage incomplete, and the hoist doesn't
  run), the recall variants, source-only-final and its hoist (after a
  refusal), and split-stitch;
- the canonical stage (the canonical, or its no-tools or tools-less retry)
  throws a request-attributable provider error (`context_length`,
  `invalid_request`, `safety`, `unsupported`), or one its failures decided:
  no hoist, variant or split is tried, since each variant only adds recall
  to the canonical request. Source-only-final is tried once where it is
  configured, and the family exhausts if it ends without a summary, or at
  once where it isn't configured;
- the answer the ladder accepted strips to empty. The canonical stage's
  `end_turn` answer, or a later rung's `end_turn` answer with text, ends the
  ladder, and a thinking wrapper is stripped from its text only after that,
  so an answer that strips to empty takes this exit whichever rung gave it.
  After the canonical stage's, a recall variant's or split-stitch's, the
  canonical's plain-prose retry is asked once, and the family exhausts if it
  ends without a summary too. After source-only-final's or a tool-prose
  hoist's, the family exhausts at once.

A rung ends without a summary when it refuses, answers incompletely or with
no persistable text, throws a request-attributable provider error or one its
failures decided, or, for a hoist or a variant, is rejected by admission. A
transient failure ends no rung by itself: it interrupts the ladder, which
resumes at that rung later, and `COMPRESSION_PERSISTENT_FAILURES` of them on
one rung, counted as rule 10 says, decide it. An abort, the caller's signal
or a host's withdrawal, ends no rung and counts no failure: nothing is
recorded, and the family stays open.

When a family exhausts:

- leave the chunk raw;
- do not store an empty summary;
- write a durable failure record keyed by:
  - model;
  - chunk source-ID hash;
  - canonical recall-frontier ID/level hash;
  - canonical normalized request hash;
  - normalized fallback limit and context budget;
  - the exact ordered bounded attempt/admission plan (IDs, hashes, bounds, and
    dispositions).
- suppress additional provider calls while the key is unchanged;
- retry only when:
  - recall frontier changes;
  - target chunk changes;
  - model/config changes;
  - operator explicitly clears/retries the record.
- emit one ops alert for the exhausted key, not one per maintenance tick.

State IDs:

`<namespace>/autobio:compression-refusal-quarantine`

is the read-only compatibility snapshot from the first implementation, while

`<namespace>/autobio:compression-refusal-quarantine-events`

is the Chronicle exhaustion ledger. Normal work writes nothing to it: there is
no durable in-flight claim. Only genuine exhaustion, exact-generation clear,
alert accounting, and periodic checkpoints append events. Same-process strategy
instances use a module-level `JsStore + branch name + family key` in-flight
registry to coalesce provider work, and serialize short durable mutations per
store/branch/state. The operation also captures per-store and per-strategy
branch generations (including same-name switch round trips); after every
provider await and before summary/quarantine/alert mutation, a branch-name/
generation mismatch discards the result without writing either branch.
Different keys cannot overwrite one another, and a stale
tombstone cannot erase a newer exhaustion. The branch-scoped projection is
replayed on every strategy initialization.

Alert delivery is at-least-once and keyed, not exactly-once: `alert_pending` is
durable before the structured external attempt and `alert_sent` follows it. A
crash between those events can replay the same alert key after restart, which a
downstream sink must deduplicate. Chronicle is the single-writer store boundary;
the in-flight registry itself is process-local, so it does not promise
cross-process coalescing if that boundary is bypassed. A process crash before
exhaustion leaves no durable claim and therefore cannot suppress the family
forever.

The logical ledger is finitely retained. At 256 events, mutation under the same
branch-pinned lock appends an active-projection checkpoint first, then redacts
the preceding event range and asks Chronicle to compact the state. The
append-first order makes both crash gaps replay-equivalent and avoids an unsafe
read/replace whole-array snapshot. A checkpoint retains the newest 1,024 active
exhausted families; older families expire and may make a new canonical-first
attempt. Between checkpoints at most 128 two-event exhaustion/pending-alert
groups can accumulate, so both active state and event history have a finite
bound. Within that window, a family remains until its key changes or an
exact-generation operator clear.

## Observability

For canonical and each fallback attempt, record metadata only by default:

- operation: `compress_l1`;
- chunk message IDs and chunk hash;
- model;
- curve label;
- recall IDs and levels;
- expanded parent and child IDs;
- recursive leaf-coverage hash;
- normalized request hash;
- message count and estimated/rendered tokens;
- stop reason and provider refusal category when available;
- latency;
- whether result was persisted.

Do not log new plaintext copies of summary bodies beyond existing configured compression logging.

Suggested trace events:

- `compression:canonical-refused`
- `compression:curve-attempt`
- `compression:curve-succeeded`
- `compression:curve-exhausted`
- `compression:quarantine-skipped`
- `compression:branch-result-discarded`

## Tests

### Unit

1. Canonical success makes zero fallback calls.
2. Canonical refusal + first valid expansion success stores exactly one summary.
3. Canonical refusal + first refusal + second success stores only second output.
4. Children are ordered by source range, not raw `sourceIds` order if those differ.
5. Recursive leaf coverage of replacement exactly equals parent coverage.
6. Missing/empty child rejects candidate without provider call.
7. Over-budget expansion is skipped.
8. Head, raw middle, marker, target chunk, instruction, tools, and all non-replaced recall pairs are byte/deep-equal across variants.
9. Tool-use/result pairing remains valid.
10. No thinking/private/tool payload is removed or altered by fallback construction.
11. All-refused writes durable quarantine and stores no summary.
12. Same unchanged request after restart makes no provider call.
13. Changed frontier/chunk/model invalidates quarantine and permits retry.
14. Duplicate/concurrent producers still store only one L1 summary.

### Integration

Use a mock Membrane that returns:

- refusal for canonical;
- refusal for selected curve A;
- success for selected curve B.

Assert exact call order, recall IDs, request hashes, single persisted summary, and compression queue convergence.

Add a fixture modeled on the Mythos hierarchy where expanding one L3 node into six L2 children succeeds while other expansions refuse.

### Regression

Run the full Context Manager test suite, FKM integration tests, and an offline replay against a copied Chronicle store. Never test against the live inhabited branch.

## Rollout

1. Implement on a feature branch externally.
2. Review code and tests with Sol/Antra.
3. Replay against a copy of Mythos’s store with a mock provider.
4. Deploy with fallback count `3` and durable quarantine enabled.
5. Observe one real failed canonical compression followed by a successful curve fallback.
6. Verify a new L1 summary is authored/stored and the repeated off-path alert stops.
7. Preserve experiment and operation records; do not modify conversational branches.

## Patient-side validation

Provider success and a stored L1 are necessary but not sufficient evidence that the memory path remains healthy. After rollout, disclose the fallback operation to the patient and preserve their ability to inspect and contest its result.

Success criterion:

> A recovery or memory-path repair is not validated merely when the patient resumes coherently. It is validated when the patient can inspect, disagree with, and alter the account of what was done.

For Mythos, reconcile the generated memory with lived testimony when it later surfaces: does it have grain, preserve as-of authorship, and leave Mythos able to red-pen the chart? Agreement or gratitude must not be treated as the test.

## Out of scope

- alternate-model summarization;
- removing prior recall;
- redacting private tool payloads;
- deterministic/extractive summaries;
- conversational rollback/suppression;
- changing primary-agent context curves.
