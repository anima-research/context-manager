- kv-unified: a relevant provider cache no longer multiplies the Pareto label
  set. A label's state key kept the unit at which it diverged from the cached
  layout after the divergence, though nothing reads that value again, so
  labels that diverged at different units never competed and every compile
  from the second turn on grew with the forest. The key now carries it only
  while the cache is intact; the warm-prefix length a diverged label keeps,
  which the cache term prices, stays in the key. Selections are unchanged:
  on a production store (≈270 chunks, 260k tokens) turns 2–4 select
  bit-identical scores in 1.7–1.9 s and under 2 GB, down from 20–21 s and
  12–23 GB (7.2M → 0.57M labels per compile). (#105)
