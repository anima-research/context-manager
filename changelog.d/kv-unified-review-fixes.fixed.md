- kv-unified review fixes: a certified base solve no longer overstates a
  merge's benefit (the certificate lets the carried layout score up to
  `adoptEpsilon` above the best cut, so a merge that passes the gate
  against it is decided against the unrestricted base solve); the Pareto
  engines and the certificate price a forest not built from the current
  inputs with the current chunks; a kept cache-layout translation with an
  unknown unit is rebuilt once the forest holds that unit; a forest derive
  declines a placed summary deleted from the same input map; a solve's
  per-solve caches are scoped to that solve even when the caller reuses
  the options object; the whole-message token memo checks every block's
  identity; a branch switch drops the cross-compile holders.
