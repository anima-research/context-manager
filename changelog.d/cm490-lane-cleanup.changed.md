- Compression and merge ticks join started work without a fallible branch
  lookup in between. Pending slots are released by local load/promise ownership,
  even when branch observation fails; failure probes preserve the attempt error,
  and local L1 retry eligibility is retained when the store cannot be observed.
- A public quarantine clear reports uncertainty even when its post-clear branch
  read fails; stale/uncertain errors direct callers to inspect the original
  branch and dispatch fresh intent rather than retry obsolete continuations.
- Stale quarantine status reads report unreadable even for empty replacement
  ledgers. Strategy retraction lookup and legacy post-append presentation scope
  failures are contained as hook failures rather than failing stored operations.
