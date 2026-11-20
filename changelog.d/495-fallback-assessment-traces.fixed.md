- Attribute counted compression failures to the stripped or unstripped run per
  attempt, rather than by thrown error identity. The flag is set at stripped
  dispatch, stays set through rejection handling (including local errors there),
  and clears on answer. A counted failure uses the stripped key only while the
  flag is set; local failures after an answer use the unstripped key.
  Deterministic provider rejections end the rung's runs instead of counting
  toward them, and aborts start none. Shared error objects no longer cause
  cross-attempt misattribution, and primitive errors are handled. This can
  change retry counts and when persistent failures contribute to quarantine.
- Keep each answered canonical-stage attempt's own logged outcome when a later
  retry succeeds, fails or is interrupted. Final attempt traces report recall
  expansion, hoist and source-only answers that extract to empty as
  `unusable_empty`. The early recall `compression:curve-attempt` classifies
  the assessment snapshot, so it can report success even if final extraction
  is empty. Split-part traces classify the trimmed raw text accepted by the fold.
  Canonical extraction errors now report `provider_error` with
  `malformed_content`. These trace corrections do not change which answers
  are accepted.
- Build L1 ladder attempt and final log receipts only when logging is enabled
  and on a best-effort basis, so a receipt construction failure does not replace
  the ladder's result.
