- Opt-in compression attempt logs add an `admission` breakdown for gated
  recall expansions and both tool-prose hoists that answer, are deterministically
  rejected by the provider, or are rejected by the admission gate. The breakdown
  includes the base rung, provider input tokens (or unknown), accounting source,
  added sent-form tokens, bounded input, output reserve, admitted total and budget.
  Source-only-final accounting is distinguished from canonical accounting.
- Provider-rejected hoists and rejected canonical-stage, source-only-final and
  split-part requests now emit attempt traces. Provider-rejection traces describe
  the request handed to Membrane, including a carrier-stripped retry when used;
  if it cannot be serialized, the trace can instead report the planned request
  as `planned-fallback`. Admission rejections report the planned request with
  zero call latency. Interrupted calls do not emit an attempt or admission trace.
- **Compression log consumers:** `compression:canonical-rejected` now carries the
  rejected stage's attempt trace when available and the durable outcome otherwise.
  Use `curveLabel` to identify the stage; the trace's request hash can differ
  from the planned-rung hash in the durable outcome.
- Set `CONTEXT_MANAGER_COMPRESSION_LOG` before compression starts and keep it
  fixed until compression finishes. Changing it mid-run can omit parts of the
  trace.
