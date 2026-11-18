- Report extracted-empty hoist and source-only answers as `unusable_empty`
  in compression attempt diagnostics, and retain malformed-response error types.
  Otherwise valid split-part traces instead classify trimmed raw fold text: empty is
  `unusable_empty`; nonempty is `success`, including a thinking-only part when
  wrapper recovery is disabled. Raw parts are stitched before summary extraction.
  Fold acceptance, summary selection and durable outcomes are unchanged.
- Preserve main's shared local/provider failure-run reset order: carrier progress
  is written before reset, and L1 and merge lane resumes precede reset. Repeated
  local resume-warning failures therefore accumulate toward the persistent bound
  when other compression lands between retries; diagnostic traces do not reset
  that history. Split-part answers end only their part key after resume, not the
  enclosing split-stitch run. Local/provider histories remain shared.
- Keep decided failures visible when final-request diagnostic
  construction fails, using an explicitly marked planned-request fallback.
- Reuse the required pre-dispatch request serialization and hash for planned
  diagnostic snapshots, avoiding extra full-request passes when logging is enabled.
- Distinguish compression-log entry serialization failures from write failures,
  include event/rung/chunk context for curve-attempt warnings, and distinguish
  planned snapshot warnings from planned-fallback trace warnings. Pass the captured
  chunk hash on canonical and split-stitch events as well.
- Guard final receipt telemetry construction, and skip it when logging is disabled,
  so throwing request getters cannot replace compression results.
