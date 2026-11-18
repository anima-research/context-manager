- Opt-in compression attempt logs include an `admission` decomposition for
  gated recall expansions and both tool-prose hoists for each answered, deterministically provider-rejected or
  admission-rejected rung: the base rung, usable
  provider input (or explicit unknown), accounting source, positive sent-form
  delta, bounded input, output reserve, admitted total and configured budget.
  Source-only-final counts are distinguished from canonical counts. Admission
  decisions, dispatched requests and durable schemas are unchanged. Stripped-versus-unstripped failure
  attribution is now attempt-local (see the compression failure-attribution fix),
  which can affect retry counts and persisted outcomes leading to quarantine.
  Set `CONTEXT_MANAGER_COMPRESSION_LOG` before compression starts and keep it
  fixed until completion; mid-flight changes cannot guarantee a complete trace.
  Provider-rejected hoists now emit curve-attempt and chunk-associated
  compression:attempt entries with the same attempt trace shape as recall rungs.
  Interrupted calls have no attempt/admission trace and remain retryable; completed
  split parts can still leave traces when a later part interrupts the rung.
  Provider-rejected traces identify the final request handed to Membrane (including
  carrier-stripped retries) and elapsed attempt time. Admission rejections describe
  the planned request with zero latency: no provider call occurred.
  Answered hoists also expose top-level totals. Failed-request diagnostics do no
  serialization or hashing with logging disabled and cannot replace provider errors.

- Preparation outside `membrane.complete` and local fallback-setup failures do not
  fabricate provider-attempt traces. A rejection from `membrane.complete` can
  originate in a host pre-request hook before adapter dispatch; these traces
  identify the Membrane invocation, not proven network activity. Failed-request
  diagnostics are best-effort: an unserializable stripped request falls back to
  pre-dispatch scalar plan diagnostics, marked `requestIdentity: planned-fallback`
  (hash, count and estimate describe the plan, latency still measures the attempt). If that diagnostic
  also fails, durable outcomes can remain without attempt traces. With logging enabled, failed calls retain a request reference through
  failure classification, then release it whether or not a diagnostic is built;
  interrupted ladder steps and split rungs release it on exit. Carrier fallback
  setup and successful stripped retries clear the failed snapshot. Decided
  split-part provider failures also emit attempt traces. Stripped-versus-unstripped run attribution is attempt-local,
  including primitive errors; dispatched-model attribution still uses the existing
  error-keyed WeakMap. Canonical and source-only rejections also emit attempt traces.
  Answered and rejected attempt timing uses a monotonic clock with fractional milliseconds;
  logging remains nonfatal even when its warning sink throws.

- **Compression log consumers:** `compression:canonical-rejected` now carries the
  rejected canonical-stage attempt trace when available, rather than the durable
  outcome record. Its `requestHash` identifies the final request handed to Membrane
  (the stripped copy after carrier fallback), not necessarily the planned rung
  hash used in family outcomes. Match `curveLabel` for the rejected stage; reused
  outcomes or failures outside the Membrane invocation still carry the durable outcome record.
  Durable family keys and outcome hashes are unchanged.
- Keep each answered canonical-stage attempt’s own outcome in attempt logs,
  including success and plain-prose retries, even when a later retry succeeds,
  rejects or is interrupted. Answers that strip to empty are unusable_empty.
  Diagnostic warning labels use the captured chunk source hash without invoking
  overridable chunk-key code outside the logging guard.
- Keep answered recall-variant outcomes in immediate curve-attempt logs, and emit
  curve-attempt logs for newly decided source-only-final provider failures. Recall
  answers that strip to empty are logged as unusable_empty, not success.
- Split-part outcomes describe the raw text the fold accepts, without changing
  fold acceptance or stitching; canonical extraction errors no longer log success.
  Planned-fallback diagnostics use a pre-dispatch scalar snapshot, immune to
  nested mutations shared with a stripped retry.
- Preserve main's failure-run reset boundaries: carrier progress writes and L1
  and merge resume warnings precede their shared local/provider run resets.
  Local errors can therefore extend an existing streak to its persistent bound;
  diagnostic tracing does not reset this history early.
