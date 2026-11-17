- Opt-in compression attempt logs include an `admission` decomposition for
  gated recall expansions and both tool-prose hoists for each answered, deterministically provider-rejected or
  admission-rejected rung: the base rung, usable
  provider input (or explicit unknown), accounting source, positive sent-form
  delta, bounded input, output reserve, admitted total and configured budget.
  Source-only-final counts are distinguished from canonical counts. Admission
  decisions, requests and durable records are unchanged.
  Provider-rejected hoists now emit curve-attempt and chunk-associated
  compression:attempt entries with the same attempt trace shape as recall rungs.
  Interrupted rungs have no attempt/admission trace; they remain retryable.
  Rejected traces identify the final dispatched request (including carrier-stripped
  retries) and elapsed attempt time; answered hoists also expose top-level totals.
