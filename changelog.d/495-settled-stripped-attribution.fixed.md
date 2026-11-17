- Clear stripped provider-failure attribution after an answer. Carrier-rejection
  reuse still resets the shared unstripped run to avoid extending old provider
  failures left by another strategy. Repeated post-answer local errors after
  reuse restart rather than accumulating; a distinct local-error identity is
  not implemented. This reverts the earlier preservation-on-reuse change.
