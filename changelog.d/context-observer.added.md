- `ContextManagerConfig.observer` (`ContextObserver`): a host is told, as each
  happens, of every compile, of each refusal context-manager itself makes of
  compression, and of each calibration sample. The manager hands the observer
  to its strategy in `StrategyContext.observer`. Each callback is optional and
  called synchronously. What it throws or rejects never reaches the work: the
  manager logs a callback's first failure once through its diagnostics and
  drops the rest, so a compile's result is the same with an observer as
  without one. Outside that is a returned promise no JavaScript can give a
  handler, such as one whose `constructor` or species can't be used, or a
  proxy around one: its rejection goes unhandled, which ends a Node process
  by default. A record's
  error and render stats are the objects the caller gets, so an observer
  treats them as read-only.
  - `compile(record)`, once per `compile()`: the strategy, `dryRun`,
    `startedAt` on the wall clock (`Date.now()`), the whole compile's
    `durationMs` on the monotonic clock, `outcome` (`'compiled'`, `'refused'`
    for one of `COMPILE_REFUSALS`, or `'failed'`), the thrown `error` itself,
    and a compiled compile's `renderStats`, the object its result holds.
  - `compression(record)`: a `reason` from `COMPRESSION_REFUSALS`
    (`'admission-rejected'`, `'topology-violation'`, `'empty'`, `'incomplete'`,
    `'malformed'`, the split rung's caps, `'chunk-call-cap'` and
    `'window-call-cap'`, and `'overlap-guard'`, a chunk refused because an L1
    already covers part of it). A provider's refusal or error on a compression
    call isn't one of these.
  - `calibration(record)`, once per sample `reportRealInputTokens` takes: an
    `outcome` from `CALIBRATION_SAMPLE_OUTCOMES` (`'out-of-band'`, `'held'`,
    `'confirmed'`, `'replaced'`, `'stepped'`), the `ratio`, and the
    `multiplier` after.
- `OverBudgetError.stageId` names which stage refused, from the exported
  `OVER_BUDGET_STAGES`, so a host needn't parse the message. The library's own
  strategies give it through the constructor's new `stageId` option, whose
  words open the message when no `stage` is given. The constructor's `stage`
  is unchanged: a strategy's own words, which open the message exactly as
  before. Given words alone, `stageId` reads `'strategy-defined'`, a new id;
  given a `stageId` beside them, it reads that id; given neither, it's
  `'picker-exhausted'`. Every message reads as before, and
  `AutobiographicalStrategy`'s protected `overBudgetError` is still given each
  stage's words as `stage`.
