- Report extracted-empty hoist and source-only answers as `unusable_empty`
  in compression attempt diagnostics, and retain malformed-response error types.
  Otherwise valid split-part traces instead classify trimmed raw fold text: empty is
  `unusable_empty`; nonempty is `success`, including a thinking-only part when
  wrapper recovery is disabled. Raw parts are stitched before summary extraction.
  Fold acceptance, summary selection and durable outcomes are unchanged.
- End an answered compression call’s own provider failure run before resuming
  its lane. Split parts end only their part key; the enclosing split-stitch
  failure run ends when the whole fold completes, not on each part's answer.
  Local errors still share provider-run identities. Ending a run on an
  unstripped provider answer, before a carrier progress write or L1 lane
  resume, or on a merge answer before merge resume, can reset repeated local
  failures. For example, a resumed-warning sink that throws after every
  successful answer can restart at one on every retry, never deciding the
  rung even when other compression lands between retries; paid calls can
  continue. Separate local/provider retry histories are deferred; this round
  changes no retry accounting.
- Keep decided failures visible when final-request diagnostic
  construction fails, using an explicitly marked planned-request fallback.
- Reuse the required pre-dispatch request serialization and hash for planned
  diagnostic snapshots, avoiding extra full-request passes when logging is enabled.
- Distinguish compression-log entry serialization failures from write failures,
  include event/rung/chunk context for curve-attempt warnings, and distinguish
  planned snapshot warnings from planned-fallback trace warnings.
