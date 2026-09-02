# Mythos gap-preserving migration note

Status: validated repair plan and implementation evidence, 2026-09-02. Raw
store data remains on the dedicated Mythos machines; this repository records
only aggregate counts, hashes, and the fail-closed surgery logic.

## Why the broad rebuild was rejected

Strict canonicalization initially found 67 non-contiguous reachable summaries
in the stopped Mythos export. Retiring those summaries and their authored
ancestors would have removed 68 memories, raised the temporary folded floor to
about 1.08M tokens, and required a model-driven drain. Inspection showed that
this was the wrong diagnosis: the affected upper summaries still had exactly
their authored participant children. Their ownership sets were disjoint and
nested; later restore/branch insertions merely interleaved other ownership
branches in chronological order.

The repair therefore preserves historical prose and treats those interleaved
branches as protected gaps. `preserveGapBearingSummaries` is explicit, is
mutually exclusive with destructive `treeifyNonContiguousSummaries`, and keeps
strict rejection as the default when neither policy is selected.

## Interrupted-source suffix

The source agent was inadvertently available during the migration window. The
correct unit, `mythos-agent.service`, was stopped and the files remained stable
across a five-second post-stop check. The final suffix added 53 messages, three
summaries, and 16,486 raw estimated tokens relative to the earlier export. It
is included in the repair base, not replayed or discarded.

The stopped source and preserved post-incident copy matched byte-for-byte:

- `records.log` (8,365,066,816 bytes):
  `6a3edf9a77283e018aa8ce8141a464928de8c478e4d45fcd93df65eae49fc03c`
- `state.bin` (70,257 bytes):
  `0441e3f351c76818d7f862544e0152f3dcbcd8f962689de951bc002e22ea9dfc`
- `branches.bin` (7,587 bytes):
  `be4f832bcb34cb6e5d4dc0e63254e1636e30d5c674512bb5e991104738676421`

The pre-incident snapshot remains untouched as a separate rollback point.

## Minimal ownership surgery

`scripts/repair-mythos-ownership.ts` validates reviewed object hashes before
writing. On a copy it:

- moves six leaves between existing record-backed L1s;
- reconciles 18 record/source metadata contracts and adds explicit boundary
  notes for 113 source messages not restated by the preserved prose;
- removes only three redundant records (`c-29`, `c-31`, and the now-merged
  `c-249`);
- creates no uncompressed debt; and
- regenerates no summary.

`L1-452` remains in the append-only archive but becomes unreachable because
the surrounding record is represented by `L1-453`. No content is silently
assigned to it.

## Post-repair evidence

The repaired export contains 73,224 message leaves and 3,581 archived
summaries. Canonical ownership reaches 3,580 summaries; strict mode reports 54
remaining chronological gaps and no L1 gap. Gap-preserving mode retains all
3,580 reachable summaries, computes an exact floor of 122,812 tokens under a
310k wall, and produces a representative 287,805-token frontier.

On the dedicated M-series target, canonicalization plus the exact floor took
about 0.22s and the representative bounded solve took about 0.54s without a
presentation/cache receipt. A pre-repair 73,171-leaf cache-relevant stress run
took about 2.7s. Small-forest tests independently compare the buffered DAG
against the left-to-right oracle and verify that an interleaved warm prefix is
priced in chronological render order.
