- Report extracted-empty hoist and source-only answers as `unusable_empty`
  in compression attempt diagnostics, and retain malformed-response error types.
  Otherwise valid split-part traces instead classify trimmed raw fold text: empty is
  `unusable_empty`; nonempty is `success`, including a thinking-only part when
  wrapper recovery is disabled. Raw parts are stitched before summary extraction.
  Fold acceptance, summary selection and durable outcomes are unchanged.
- End an answered compression call’s own provider failure run before resuming
  its lane. Split parts end only their part key; the enclosing split-stitch
  failure run ends when the whole fold completes, not on each part's answer.
  Local errors still share provider-run identities and can be reset by answers.
- Keep decided failures visible when final-request diagnostic
  construction fails, using an explicitly marked planned-request fallback.
- Reuse the required pre-dispatch request serialization and hash for planned
  diagnostic snapshots, avoiding extra full-request passes when logging is enabled.
