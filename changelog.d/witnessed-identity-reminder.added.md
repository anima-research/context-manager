- `witnessedIdentityReminder` is a separate identity reminder for wholly
  inherited targets: L1 chunks entirely before `witnessedBeforeSequence`,
  and merges whose every source is witnessed. Every other target keeps
  `identityReminder`, including a chunk that spans the pin, each piece the
  split rung folds such a chunk into, and a merge of inherited and lived
  sources. Such a mixed request shows inherited and lived material
  together under the live instruction and reminder, with no label saying
  which is which, so after a rename the new live reminder reaches the
  inherited material in it. The protection is opt-in. With only
  `identityReminder` set, the library appends it, current name included,
  to wholly inherited targets too, so an inherited-history migration
  should set `witnessedIdentityReminder`. The offline drain script passes
  it from the recipe. Unset, requests are unchanged.
