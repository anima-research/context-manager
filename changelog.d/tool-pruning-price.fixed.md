- A tool result `toolResultMaxLastN` replaces, and a `tool_use` input
  `toolUseInputMaxTokens` truncates, are now priced as sent, in both
  selections. Both were priced whole in the plan, its layout and the render
  stats, while the request carried the marker or the truncated input. So a
  compile's window held less than its budget allowed, and the adaptive
  selection's calibration compared provider usage against the over-count.
  Where replaced results were a large share of the window, every sample was
  rejected as out of band and the store never calibrated. Where they were a
  smaller share, the store learned a multiplier low by that share, which
  priced everything else low. A result the limit replaces is now replaced
  before the cap (`maxMessageTokens`) cuts its message, so the cap no longer
  spends its budget on that result's text, and the message is priced as it's
  sent, where it was priced at what the cap left of the result.
  - The estimator's calibration starts pricing epoch 4. A store holding a
    result the limit replaces, an input over the input cap, or a result that a
    per-tool limit in a map that isn't a number replaces when read as `main`
    read it, such as null (which replaced every result of its tool), discards
    a multiplier learned under 3, with an `[estimator-calibration]` warning
    and `calibration.reset` in the render stats, and restarts from a
    provisional 1, which the first provider sample the sanity band accepts
    sets outright. Kept, a multiplier learned low against the over-count would
    price every window low once the over-count was gone, and a compile could
    go out over its hard budget by that margin with no refusal. At 1, a
    compile is off by the store's own multiplier until the first accepted
    sample, normally the first compile's. A store holding none of these keeps
    its multiplier.
