- Avoid a nested action-cache Map for the first level of each immutable action
  array, allocating a fallback Map only when that array is used at more levels.
- Reuse a shared visitor function for internal packed trace references while
  preserving public detached-callable references, traversal order and lazy reads.
  These changes reduce specific lookup/function-allocation work; comparative
  wall-time, total allocation, peak-memory and GC improvements are unproven.
