- `kvUnified.hysteresisCertificate` is now a strategy config key (passed
  through by the adapter like the other `kvUnified` fields), so the certified
  hysteresis exit can be switched on from a recipe. The certificate also no
  longer declines when an appended leaf has a fold option (a freshly minted
  L1 over new messages): it enumerates every cut that keeps each accepted
  leaf at its accepted level (capped at 256, else it declines as before),
  scores them exactly, and certifies the best one — which is what the full
  solve's hysteresis rule selects. On a copy of Sill's store, 24 of 25
  unchanged turns certified at ~0.4 s instead of a 4–6 s solve.
