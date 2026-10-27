- `ContextManager.previewContext` returns `null` on the hierarchical path
  (`adaptiveResolution` off) when its select succeeds, as its doc says it
  does when the strategy has no fold plan to preview. It used to let through
  the plain `Error` that `AutobiographicalStrategy.previewContext` throws there
  ("previewContext requires adaptiveResolution; …"). A caller that matched
  that error's text gets `null` instead. Over the budget, the hierarchical
  path still returns an infeasible preview. `AutobiographicalStrategy`'s own
  `previewContext` still throws there, with the same message.
