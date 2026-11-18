- Preserve the original compression provider/admission error when a subsequent
  branch probe throws, attaching the observation error as its cause when the
  original error permits it and has no existing cause. Keep failed same-load L1
  work retryable without another fallible branch probe before local requeueing.
