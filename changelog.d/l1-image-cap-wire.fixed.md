- The L1 mint builder's compression-image byte cap now applies to the
  post-split wire messages instead of the pre-split `llmMessages` list.
  `splitMixedToolMessages`/collapse rebuild message objects, so the cap was
  logging its strips against copies the request never shipped — a mixed tool
  round carrying an image kept its image on the wire under ANY
  `maxCompressionImageBytes` (field repro 2026-09-21: "replaced 1 older
  image ... kept 0MB" logged while the same mint failed with the provider's
  image-input 400). The merge builder has always capped its post-split list;
  the L1 builder now matches it.
