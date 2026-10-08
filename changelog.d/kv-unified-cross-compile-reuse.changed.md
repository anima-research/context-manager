- kv-unified reuses what did not change between compiles: the canonical
  forest, the receipt SummaryTree and the certificate's context DAG are
  derived from the previous compile when no summary, recall cost or L1 link
  changed; leaf representation hashes and positions live on the forest leaf;
  the certificate scores through the terminal evaluator with a linear
  compile; message token estimates, salience and the post-strip pass keep
  their caches across appends; receipt submission reuses unchanged leaves.
  Layouts are unchanged; a warm compile on a 75k-message history drops to
  roughly a third of its previous wall time.
