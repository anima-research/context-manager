- Bound live and dry floor-warning deduplication to 64 fixed-size keys each.
  An evicted cause can warn again. Normalization affects only the retained
  keys: the log still includes the original cause with its dry/live label.
