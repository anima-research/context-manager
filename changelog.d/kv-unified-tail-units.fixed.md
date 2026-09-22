- kv-unified cache model: the raw tail now renders as one unit per message
  (keyed by chunk id, the same identity a message keeps after it slides into
  the middle) instead of one opaque `tail` unit. With the opaque unit every
  append shifted the tail's position — the messages leaving the tail became
  new raw units in front of it — so the end-of-tail marker fell outside the
  identical prefix and an unchanged layout was priced as the whole tail
  (~100k tokens on Sill) recomputed on every turn, although the wire bytes
  were identical. Selection was unaffected (the false churn was the same for
  every candidate and cancelled in the floor normalization), but reported
  churn and `cacheFloor` were wrong and the opt-in hysteresis certificate's
  zero-churn precondition could never hold in steady state. Applies to
  `renderLayout`, both solver storages and the terminal evaluator; cache
  markers on tail messages now map to that message's unit. Tail tokens not
  attributed to any tail chunk (synthetic inputs only) keep the opaque block,
  so token totals are unchanged. The first solve after upgrading sees the
  persisted opaque-tail layout diverge once; subsequent receipts are per-message.
