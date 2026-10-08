- The kv-unified compile keeps its per-compile structures across a
  summary arrival. When a compile adds summaries, re-parents children
  under them or owns more leaves, the forest is extended from the
  previous one: only the leaves whose ownership chain changed and the
  summaries on an old or new chain of such a leaf are rebuilt, every
  other leaf and summary object is shared, and the forest names its
  parent and what changed. The summary tree rebuilds only the nodes of
  new or re-parented summaries. The terminal evaluator translates the
  parent's slots instead of recomputing them, and the certificate DAG
  and the accepted-level cache keep the nodes of leaves and fully
  covered summaries the extension did not touch. A derive compares each
  leaf with its own record of the chunk it was built from, so a chunk
  changed in place (a pin, a lock, a token count) is seen; a kept
  cache-layout translation is reused only where the structure still
  holds the same leaf ids; a tree node built while a source was missing
  is rebuilt when that source arrives. Forests, trees, DAGs, labels,
  layouts, resolutions and receipts are unchanged.
