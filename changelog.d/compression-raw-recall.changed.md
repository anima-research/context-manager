- L1 and L2 compression no longer interpret recall-shaped raw Context Manager
  turns as constructed recall headers. Even with default settings,
  consecutive same-participant source turns can now collapse without the
  synthetic conversation-resumes separator previously inserted there. This applies before
  the L1 opening and throughout L2 raw sources as well. Cache seams and
  recall-curve replacement also use constructed identity, not matching raw text.

- Changed default request bytes also change refusal-family identities. Persisted
  quarantine/ladder outcomes under the old family are not reused; absent a
  per-chunk quarantine cap, previously attempted work may incur new paid calls.

- Our earlier answer was incomplete: default instruction wording is unchanged,
  not default full request bytes or provenance hashes. Ordinary `compress_l1`
  telemetry changes too (last dispatched request and constructed recall totals).
