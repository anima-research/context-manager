- kv-unified: a relevant provider cache no longer multiplies the Pareto label
  set. A label's state key kept the unit at which it diverged from the cached
  layout after the divergence, though nothing prices that value, so labels
  that diverged at different units never competed and every compile from the
  second turn on grew with the forest. The key now carries it only while the
  cache is intact; the warm-prefix length a diverged label keeps, which the
  cache term prices, stays in the key. Bucketed representative ties now break
  on the frontier signature, as terminal selection does, instead of on that
  unit. Exact-mode selected scores are unchanged (an equal-score tie can
  resolve to a different cut, as it already could with no cache); bucketed
  selections stay within the reported bound. On a production store
  (≈270 chunks, 260k tokens) turns 2–4 select bit-identical scores in
  1.7–1.9 s and under 2 GB, down from 20–21 s and 12–23 GB (7.2M → 0.57M
  labels per compile). (#105)
