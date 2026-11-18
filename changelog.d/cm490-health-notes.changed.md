- Quarantine span status is not capped at three records: three exhausted shapes
  is a per-request-hash-regime limit, and holds from earlier model/request regimes
  remain active. `closedAgeMs` is measured from source-message timestamps; it is
  not proof that the span is still raw when cleanup fails. This clarifies the
  historical 0.20.0 release description without rewriting it.
