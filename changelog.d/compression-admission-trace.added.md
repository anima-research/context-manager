- Opt-in compression attempt logs include an `admission` decomposition for
  gated recall expansions and both tool-prose hoists for each answered, deterministically provider-rejected or
  admission-rejected rung: the base rung, usable
  provider input (or explicit unknown), accounting source, positive sent-form
  delta, bounded input, output reserve, admitted total and configured budget.
  Source-only-final counts are distinguished from canonical counts. Admission
  decisions, requests and durable records are unchanged.
  Provider-rejected hoists now emit curve-attempt and chunk-associated
  compression:attempt entries with the same attempt trace shape as recall rungs.
  Interrupted calls have no attempt/admission trace and remain retryable; completed
  split parts can still leave traces when a later part interrupts the rung.
  Provider-rejected traces identify the final dispatched request (including
  carrier-stripped retries) and elapsed attempt time. Admission rejections describe
  the planned request with zero latency: no provider call occurred.
  Answered hoists also expose top-level totals. Failed-request diagnostics do no
  serialization or hashing with logging disabled and cannot replace provider errors.

- Preparation failures do not fabricate provider-attempt traces. Failed calls retain request references only while constructing opt-in diagnostics;
  successful stripped retries clear the failed snapshot. Run attribution is attempt-local,
  including primitive errors. Canonical and source-only rejections also emit attempt traces.
  Answered and rejected attempt timing uses a monotonic clock with fractional milliseconds;
  logging remains nonfatal even when its warning sink throws.
