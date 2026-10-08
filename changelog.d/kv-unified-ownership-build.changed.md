- The kv-unified compile does less fixed work when ownership changes (a
  new summary). The forest full build walks each L1's ownership chain
  once, resolves a chain to its summaries once, keeps leaf lists in
  position order (contiguity is a span check), shares level lists and
  summary hashes per chain, and copies an already ordered chunk list
  instead of sorting it. The summary tree walks each summary's leaves
  once per build and keeps ordered lists unsorted. The certificate DAG
  addresses leaves by forest position and takes a fully covered summary's
  participants from the forest's cached index array. The packed solver
  prices and emits actions through leaf positions its callers already
  hold. The strategy's coverage invariant remembers each emitted
  summary's store positions per store order. Forests, trees, DAGs,
  labels, layouts, resolutions and receipts are unchanged.
