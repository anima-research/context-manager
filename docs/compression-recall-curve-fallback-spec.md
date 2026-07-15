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

1. **Canonical first.** Always issue the current canonical compression request unchanged. Fallback activates only after canonical `stopReason === "refusal"`.
2. **Same as-of model.** Do not use a neutral observer or alternate model/provider.
3. **No semantic omission.** Preserve head, raw middle, target chunk, tool cycles, instruction, and all leaf-history coverage selected by the canonical recall frontier.
4. **No private-state sanitization.** Do not remove, redact, deduplicate, or placeholder `think`, `skip_reply`, thinking, tool, or other state as part of this feature.
5. **Authored nodes only.** Alternate curves may use only summaries already authored and persisted by this instance. No mechanical or external summary may be introduced.
6. **Chronology preserved.** Replacement children occupy the parent node’s exact chronological position and remain ordered by source range.
7. **No future leakage.** The alternate request must retain the same as-of boundary; no tail-after-chunk.
8. **Coverage proof.** A replacement is valid only if recursively expanded leaf message IDs exactly equal the parent’s leaf coverage.
9. **Store once.** Only the first successful response may become the chunk’s L1 summary. Refused/aborted diagnostic outputs are never persisted as memory.
10. **Bounded retries.** Never loop indefinitely on the same chunk/frontier/request state.

## Fallback algorithm

### Canonical request

Build and issue the request exactly as current `compressChunkHierarchical()` does.

If `stopReason !== "refusal"`, preserve existing behavior.

If `stopReason === "refusal"`, retain the complete canonical request and canonical selected recall frontier for variant construction.

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

Stop at first non-refusal response.

### Optional later variants

Only after single-node direct expansions are tested:

- uniform maximum-level curve (expand every node above level N);
- two-node expansion combinations.

Do not include these in v1 unless single-node expansion proves insufficient across real incidents; combinatorics and prompt size grow quickly.

## Durable refusal quarantine

If canonical and every allowed variant refuse:

- leave the chunk raw;
- do not store an empty summary;
- write a durable failure record keyed by:
  - model;
  - chunk source-ID hash;
  - canonical recall-frontier ID/level hash;
  - canonical normalized request hash;
  - attempted variant IDs and hashes.
- suppress additional provider calls while the key is unchanged;
- retry only when:
  - recall frontier changes;
  - target chunk changes;
  - model/config changes;
  - operator explicitly clears/retries the record.
- emit one ops alert for the exhausted key, not one per maintenance tick.

Suggested state ID:

`<namespace>/autobio:compression-refusal-quarantine`

A process-local set is insufficient because restart would resume hammering.

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
