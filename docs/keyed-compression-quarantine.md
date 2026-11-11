# Selected L1 compression-quarantine waiver

This optional **library capability** inspects an already loaded strategy and
waives one observed L1 refusal hold. It is not an operator transport, an
authorization boundary, a scheduling command, or a coverage receipt.

```ts
import { isKeyedCompressionQuarantineStrategy } from '@animalabs/context-manager';

const strategy = manager.getStrategy(); // the existing loaded instance
if (!isKeyedCompressionQuarantineStrategy(strategy)) {
  throw new Error('Keyed L1 quarantine capability unsupported');
}
const view = strategy.inspectCompressionRefusalQuarantine({ limit: 50 });
// Present metadata to the operator. Do not automatically select records.
// Retain view.binding and the explicitly selected record's key + generation.
```

After separate operator confirmation, on that same loaded instance:

```ts
const result = await strategy.releaseCompressionRefusalQuarantine({
  key: selected.key,                       // one full lowercase SHA-256 key
  expectedGeneration: selected.generation, // non-null actual native identity
  expectedBinding: observedBinding,        // namespace + branch + opaque loadId
});
```

The host must validate confirmation, instance identity and operation intent;
these library tokens are neither credentials nor proof of human consent.
Never fall back to `clearCompressionRefusalQuarantine()` on an unsupported
strategy: that legacy library method accepts an omitted key meaning all.

## Inspection

`inspectCompressionRefusalQuarantine({ key?, limit? })` is synchronous and
metadata-only. It uses the existing native projection without a maintenance
tick, paid-off sweep, repair, provider request, or journal write. Calling it
before initialization, after detach, or after an uninitialized branch change
returns `branchUnavailable`. A failed/malformed read returns `unreadable`,
not an empty list. It conservatively refuses damaged historical events even
if a later checkpoint could supersede them; it never rewrites them.

- The default list limit is 50, valid range 1–100. Records sort by full key.
  `complete: false` means the selection was truncated; `totalRecords` is the
  entire projected active record count, **not distinct chunks/spans**. This
  first version has no page cursor; an exact full-key query can inspect a
  known key outside the bounded list. Do not claim exhaustive enumeration
  when `complete` is false. Projection still reads the native ledger in full;
  this bounds output entries, not ledger I/O or total string bytes.
- With `key`, `complete` refers only to that exact-key selection, not to the
  full quarantine. An absent key returns an empty selection with the actual
  `totalRecords`. Invalid keys/limits return `invalidSelection`.
- `generation` is the actual active exhaustion event id, or the actual claim
  id in the older claim/exhaustion format. Checkpoints preserve that identity.
  Legacy snapshot-only lineage has `generation: null`, `selectable: false`.
  Noncanonical historical keys are also not selectable; there is no synthetic
  generation upgrade or schema repair.
- `binding.loadId` is opaque and local to a committed strategy load. It binds
  the store, namespace and branch lifecycle, not the conversation head. A
  normal append leaves it valid; reinitialize, detach, manager branch switch
  (including away-and-back) or strategy replacement invalidates it. As with
  native branch fencing, an unobserved direct store switch away-and-back
  outside ContextManager is not detected; use the manager lifecycle.
- Source ids are recorded membership if present, otherwise an exact hash
  match to a loaded chunk, otherwise `null`/`membership: 'unknown'`.
  `loadedChunkMatch` separately says whether an exact chunk is loaded now;
  false does not prove the source is gone or ineligible. Malformed recorded
  membership or a source-hash mismatch is unreadable, not an empty span.
- Family key, canonical request hash, frontier hash, recorded model, creation
  time and the small numeric/boolean profile are included only as recorded.
  Missing profile booleans are `null`, not retroactively defaulted. No full
  request config, tool arguments, instructions, raw text, thinking, signatures,
  provider response bodies, error bodies or authentication material is returned.
- Only bounded normalized outcome/stop-reason labels and recorded request
  hashes are returned. Unrecognized labels become `unknown`/`null`, not copied
  arbitrary text. There is no inference from the latest aggregate or topics.
  Outcomes/source ids/sibling keys are capped at 32/100/100 respectively,
  with independent completeness flags. `sameSourceRecords` includes this
  record and all currently observed same-hash siblings, regardless of limit.

`configuredModel` is this strategy's current configured compression model;
`recordedModel` belongs to the historical record. Neither establishes an
actually used upstream model. `recordedProvider`, `recordedCategory`,
`configuredProvider` and `configuredCredentialAlias` are explicitly `null`:
this strategy has no authoritative stored correspondence for them. In
particular, provider refusal categories are not retained in these native
quarantine outcomes. A host with a separate compression route must supply
its own nonsecret configuration and actual-request observations later, without
pretending configuration is actual use or correlating an unrelated call.

## Compare-and-release decision table (host contract)

| Result | Meaning / host action |
| --- | --- |
| `released` | Exact key/generation was cleared under the native lock; includes key, generation, and observed `remainingRecords`. Record the acknowledgement; no inference of coverage or provider work. |
| `stale` | Branch/namespace/load binding or active generation differs. No mutation. Reinspect and obtain new intent, never auto-reselect. |
| `not-held` | No active record for this full key under the matched binding. No mutation. This is **not** acknowledgement of an earlier uncertain operation. |
| `unsupported` | Selected lineage has no trustworthy native generation. No mutation, no fallback writer or legacy clear. Capability absent is also unsupported at the host boundary. |
| `unreadable` | Authoritative projection could not be read/validated before writes. No mutation. Surface failure, not an empty quarantine. |
| `branchUnavailable` | Strategy has no current committed load, or branch currency cannot be established. No mutation. Resolve lifecycle rather than retrying against another instance. |
| `invalidSelection` | Missing/empty/partial/wildcard/all key, absent generation/binding, or invalid inspect bounds. No clear-all interpretation. |
| Rejected promise / exception | Mutation-path failure, potentially after a landed write. Preserve intent as **uncertain**. Do not fabricate `released` from a missing key or automatically resend. |

Comparison and mutation run together inside the existing in-process
`withCompressionStateLock`, keyed by JsStore, branch and native quarantine
state id. They do not perform a host precheck followed by the old method.
The invocation snapshots caller input before waiting. Like existing native
writers, this is **not** a new cross-process/multi-store transaction or
exactly-once receipt protocol; independent writers outside that lock are not
newly serialized. Hosts must retain the native single-writer ownership model.

On a match the operation first forgets **all progress for that family**,
then appends one native targeted `clear` event with additive
`reason: 'operator-waiver'`, syncs and rereads before acknowledging. Old event
readers ignore the extra reason and use the unchanged target identity. There
is no registration/strategy/schema or dependency change. Normal future native
checkpoints can discard tombstones: this is not a permanent operation ledger.
A failure during progress, append, sync or postread throws. A progress-only
partial write can leave the hold standing but remove its old ladder answers.

Only this active shape leaves the shape-cap count. Retained exhaustion history
does not count. Other keys, including same-source and same-family siblings,
remain held; **family** progress can be shared with those siblings and is
forgotten nonetheless, exactly as in the native legacy clear. No promise is
made that a particular chunk becomes eligible, that one provider POST follows,
or that a whole fallback ladder, provider retries or other work is isolated.
Changing the global model affects other normal compression too.

The next ordinary alarm check on the same live, already-open episode retains
remaining raw siblings and eventually reports the observed record count on
its existing interval. When a waiver-request episode reads empty it ends once,
without saying coverage/debt was paid. Release does not drive a background tick
or call the alarm handler. Episode state is not persisted; reopen-before-first-
alarm and the native paid-off sweep's other limitations are unchanged.

## Boundaries and related work

Waiver acknowledgement, native attempt, provider refusal/admission failure,
L1 commit/coverage and debt/fit are separate observations. Native scheduling,
admission, fallbacks, containment and automatic coverage clears remain
responsible for what happens next. This API neither repairs liveness nor
asserts semantic fidelity. There is no merge-hold release, model override,
message deletion, summary import, topology repair, new account or grant.

Context, not endorsements or fixes in this change:
[CM #373](https://github.com/anima-research/context-manager/issues/373)
(shape cap), [#390](https://github.com/anima-research/context-manager/issues/390)
(paid-off sweep), [#377](https://github.com/anima-research/context-manager/issues/377)
(alarm episodes), [#415](https://github.com/anima-research/context-manager/issues/415)
(liveness), [#456](https://github.com/anima-research/context-manager/issues/456)
and [#447](https://github.com/anima-research/context-manager/issues/447)
(history/split-stitch), [#369](https://github.com/anima-research/context-manager/issues/369),
[#474](https://github.com/anima-research/context-manager/issues/474) and
[#461](https://github.com/anima-research/context-manager/issues/461)
(removal/debt/trackers), [#463](https://github.com/anima-research/context-manager/pull/463)
and [host #617](https://github.com/anima-research/connectome-host/pull/617)
(compression-route observability); [host #604](https://github.com/anima-research/connectome-host/issues/604)
is field context only, and [host #277](https://github.com/anima-research/connectome-host/issues/277)
reminds consumers not to label record counts as chunks.

A future host companion must resolve the actual AF-owned loaded strategy,
feature-detect this capability, fence instance + intent + uncertain ACKs and
use its existing local authorization policy. AF alignment must be proposed
separately if its public API/dependency profile cannot expose that instance;
no dependency floor or release version is invented here. There is no new
shared HTTP/WebUI/MCP/model-tool mutation surface in this library change.
