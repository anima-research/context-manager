# Internal action evaluation

The terminal evaluator caches compiled actions by immutable action-array identity
and numeric level. Its first level is stored directly in the weak-cache entry;
other levels use a lazily allocated `Map`. Level matching preserves SameValueZero
semantics, including signed zero and NaN at the cache-key level. Arrays with equal
values but different identities remain separate weak keys. This removes the
nested `Map` lookup and allocation for single-level action arrays. Multi-level
arrays retain an additional entry object plus the fallback `Map`, a tradeoff that
has not been shown to improve latency or overall memory use.

Packed solver evaluation references retain private arena/node state and share one
prototype visitor function. They still allocate one reference object each and
retain the arena while alive. Their methods require their receiver. The existing
public `PackedTraceArena.reference()` keeps its detached-callable visitor, including
calls with foreign receivers. Both traverse newest assignments first and preserve
action-array identity, immutable ancestry and exception propagation. Action-array
mutation remains outside the immutable trace contract.

Regression coverage includes multi-level/weak-key identity, SameValueZero keys,
iterator exceptions and nested iteration, an independent parent/action oracle
across page growth, public detached calls, visitor exceptions/reentry and delayed
exact metrics/layouts. Existing certificate and packed/object solver oracle tests
also run against the combined implementation.

The user selected both changes for the PR based on their specific reductions in
lookup/function-allocation work. Comparative wall-time, total allocations, peak
RSS and GC gains remain unvalidated. EXP-34 stopped during baseline verification;
the exploratory EXP-35/36 screen was blocked by CPU precheck before any solver
work. Neither provides valid comparative timing for these changes.
