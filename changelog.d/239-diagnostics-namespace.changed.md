- Stderr diagnostics about one namespace now name it, as
  ` ns=<namespace>` at the end of their message's first line, after their
  fields, so the lines of several managers in one process, such as
  agent-framework's agents on one store, can be told apart (#239).
  Arguments after a message, such as an error, print after it as before.
  A grep for a line's prefix still matches. A reader that took a line's
  end as its last field, such as `[kv-overlap]`'s `sample=`, now finds
  ` ns=` there.
  - The strategy's lines, `[plan-vs-actual]`, `[kv-overlap]`,
    `[kv-unified]` and `[kv-escalation]` among them, the manager's, and
    the planner's, picker's, fold journal's, mint preimage's and windowed
    strategy's lines that run for one namespace name the manager's,
    `default` when it has none. A strategy no manager has initialized
    names none.
  - A message slot's lines, its cadence retune at open and `[cm-cache]`
    lines among them, and a context log's name the namespace the slot or
    log belongs to, such as an isolated or an auxiliary slot's. The
    shared message slot's, and those of a context log with no namespace,
    name none, as do lines about the store as a whole, such as the fold
    journal's index warnings.
- The JSON diagnostics `config:effective` and
  `compression:quarantine-alert`, each `[debugLogContext]` entry, and each
  entry of the compression log (`CONTEXT_MANAGER_COMPRESSION_LOG`) gain a
  `namespace` field.
- `persistMintRequestPreimage` takes an optional fourth argument, a
  `Diagnostics`, now exported as a type, which its lines go through.
  `AutobiographicalStrategy` has a new protected `diag`, the strategy's
  diagnostics, which a subclass can log through to name its namespace. A
  subclass's own member named `diag` now conflicts with it.
